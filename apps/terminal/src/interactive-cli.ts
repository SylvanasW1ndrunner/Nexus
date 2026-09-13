import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import {
  type LlmCatalogModel,
  type LlmEffectiveParameters,
  type LlmMetadataValue,
  type LlmModelSelection,
} from '@dbagent/core-llm';
import {
  initializeAgentProject,
  type UserActivityEvent,
} from '@dbagent/core-agent';
import {
  AgentRuntimeError,
  AgentRuntime,
  createBundledAgentRuntime,
  GlobalConfigValidationError,
  ProjectSettingsValidationError,
  type AgentRunHandle,
  type AgentRunResult,
  type AgentPendingQuestion,
  type AgentQuestionAnswerInput,
  type LlmConnectionSummary,
  type McpServerSummary,
  type GlobalConfigView,
} from '@dbagent/agent-host';
import { resumeCliRun } from './cli-run-resume.js';

export type InteractiveCliOptions = {
  projectDirectory?: string;
  input?: Readable;
  output?: Writable;
  /** Optional non-interactive seed for a newly created Session. */
  model?: LlmModelSelection;
};

type PendingCliApproval = {
  approvalId: string;
  handle: AgentRunHandle;
};

type PendingCliOutcome = {
  invocationId: string;
  riskyRetryClientRequestId: string;
  handle: AgentRunHandle;
};

type PendingCliQuestion = {
  request: AgentPendingQuestion;
  answers: AgentQuestionAnswerInput['answers'][number][];
  index: number;
  commandId: string;
  handle: AgentRunHandle;
  submitting?: boolean;
};

function renderPendingCliQuestion(output: Writable, pending: PendingCliQuestion): void {
  const question = pending.request.questions[pending.index];
  if (question === undefined) {
    write(output, '答案已准备完成；输入 /retry 重试提交，或 /cancel 取消问题 > ');
    return;
  }
  write(output, `\n${paint(output, 'cyan', `Agent 询问 (${pending.index + 1}/${pending.request.questions.length})`)}\n${question.prompt}\n`);
  if (question.options !== undefined) {
    question.options.forEach((option, index) => {
      write(output, `  ${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}\n`);
    });
    write(output, '输入选项序号，或直接输入自由文本 > ');
  } else {
    write(output, '请输入回答 > ');
  }
}

function cliQuestionAnswer(
  question: AgentPendingQuestion['questions'][number],
  value: string,
): AgentQuestionAnswerInput['answers'][number] | undefined {
  const text = value.trim();
  if (!text || text.length > 512) return undefined;
  const numeric = /^\d+$/u.test(text) ? Number(text) - 1 : -1;
  const option = question.options?.find((candidate, index) =>
    index === numeric || candidate.id === text || candidate.label.toLocaleLowerCase() === text.toLocaleLowerCase());
  return option === undefined ? { id: question.id, text } : { id: question.id, optionId: option.id };
}

export function classifyCliApprovalInput(value: string): 'approve' | 'reject' | 'steer' {
  const normalized = value.trim();
  if (/^(?:y|yes|允许)$/i.test(normalized)) return 'approve';
  if (!normalized || /^(?:n|no|拒绝)$/i.test(normalized)) return 'reject';
  return 'steer';
}

export function classifyCliOutcomeInput(
  value: string,
): 'succeeded' | 'failed' | 'retry' | 'invalid' {
  const normalized = value.trim();
  if (/^(?:s|success|succeeded|成功)$/i.test(normalized)) return 'succeeded';
  if (/^(?:f|fail|failed|失败)$/i.test(normalized)) return 'failed';
  if (/^(?:r|retry|重试)$/i.test(normalized)) return 'retry';
  return 'invalid';
}

export async function submitCliOutcomeDecision(
  handle: Pick<AgentRunHandle, 'authorizeRiskyRetry' | 'resolveOutcome'>,
  input: Readonly<{
    invocationId: string;
    decision: 'succeeded' | 'failed' | 'retry';
    riskyRetryClientRequestId: string;
  }>,
): Promise<void> {
  if (input.decision === 'retry') {
    await handle.authorizeRiskyRetry({
      invocationId: input.invocationId,
      reason: '用户已明确承担非幂等操作可能重复执行的风险。',
      clientRequestId: input.riskyRetryClientRequestId,
    });
    return;
  }
  await handle.resolveOutcome({
    invocationId: input.invocationId,
    outcome: input.decision,
    summary: input.decision === 'succeeded'
      ? '用户确认外部操作已成功。'
      : '用户确认外部操作已失败。',
  });
}

export class CliTraceRenderer {
  readonly #output: Writable;
  #enabled: boolean;
  #transientLines = 0;
  #expanded = true;
  #history: Array<{ value: string; replaceKey?: string }> = [];
  #replacementIndexes = new Map<string, number>();

  constructor(output: Writable, options: { enabled?: boolean } = {}) {
    this.#output = output;
    this.#enabled = options.enabled ?? true;
  }

  setEnabled(enabled: boolean): void {
    this.#enabled = enabled;
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  start(): void {
    if (!this.#enabled) return;
    this.#history = [];
    this.#replacementIndexes.clear();
    this.#transientLines = 0;
    this.#expanded = true;
    this.appendTrace(`${paint(this.#output, 'dim', '正在处理…')}\n`);
  }

  render(event: UserActivityEvent): void {
    if (!this.#enabled || event.kind === 'final') return;
    const symbol =
      event.kind === 'approval'
        ? '!'
        : event.phase === 'failed' || event.phase === 'discarded'
          ? '↻'
          : event.kind === 'artifact'
            ? '+'
            : '·';
    let value = `${paint(this.#output, 'dim', `${symbol} ${event.summary}`)}\n`;
    const detail = activityDetailRecord(event.detail);
    if (event.kind === 'approval' && typeof detail?.actionSummary === 'string') {
      value += `${paint(this.#output, 'yellow', `  ${detail.actionSummary}`)}\n`;
    }
    this.appendTrace(value, event.replaceKey);
  }

  clearBeforeFinal(): void {
    if (!isTtyOutput(this.#output)) return;
    this.clearVisibleTrace();
    this.#expanded = false;
  }

  toggle(): boolean {
    if (!this.#enabled || !isTtyOutput(this.#output) || this.#history.length === 0) return false;
    if (this.#expanded) {
      this.clearVisibleTrace();
      this.#expanded = false;
      return true;
    }
    this.#expanded = true;
    for (const entry of this.#history) this.writeVisibleTrace(entry.value);
    return true;
  }

  private clearVisibleTrace(): void {
    for (let index = 0; index < this.#transientLines; index += 1) {
      write(this.#output, '\u001B[1A\u001B[2K\r');
    }
    this.#transientLines = 0;
  }

  private appendTrace(value: string, replaceKey?: string): void {
    const replacementIndex = replaceKey === undefined
      ? undefined
      : this.#replacementIndexes.get(replaceKey);
    if (replacementIndex !== undefined) {
      this.#history[replacementIndex] = {
        value,
        ...(replaceKey === undefined ? {} : { replaceKey }),
      };
      if (!this.#expanded) return;
      if (!isTtyOutput(this.#output)) {
        this.writeVisibleTrace(value);
        return;
      }
      this.clearVisibleTrace();
      for (const entry of this.#history) this.writeVisibleTrace(entry.value);
      return;
    }
    const entry = replaceKey === undefined ? { value } : { value, replaceKey };
    this.#history.push(entry);
    if (replaceKey !== undefined) this.#replacementIndexes.set(replaceKey, this.#history.length - 1);
    if (this.#expanded) this.writeVisibleTrace(value);
  }

  private writeVisibleTrace(value: string): void {
    write(this.#output, value);
    this.#transientLines += renderedTerminalLines(value, terminalColumns(this.#output));
  }
}

function activityDetailRecord(value: UserActivityEvent['detail']): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

export async function initializeCliProject(directory = process.cwd()): Promise<string> {
  await mkdir(directory, { recursive: true });
  const project = await initializeAgentProject(directory);
  return project.rootPath;
}

export async function listCliSkills(
  options: Pick<InteractiveCliOptions, 'projectDirectory'> = {},
): Promise<Array<{ name: string; description: string; scope: string }>> {
  const runtime = new AgentRuntime({
    projectDirectory: options.projectDirectory ?? process.cwd(),
  });
  try {
    await runtime.refreshSkills();
    return await runtime.listAgentSkills();
  } finally {
    await runtime.close();
  }
}

export async function listCliSessions(
  options: Pick<InteractiveCliOptions, 'projectDirectory'> = {},
): Promise<Array<{ id: string; title: string; archived: boolean; runCount: number }>> {
  const runtime = new AgentRuntime({
    projectDirectory: options.projectDirectory ?? process.cwd(),
  });
  try {
    const page = await runtime.listAgentSessions({ limit: 100 });
    return page.items.map((session) => ({
      id: session.sessionId,
      title: session.title ?? '未命名会话',
      archived: session.archived,
      runCount: session.runCount,
    }));
  } finally {
    await runtime.close();
  }
}

export async function startInteractiveCli(options: InteractiveCliOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const projectDirectory = options.projectDirectory ?? process.cwd();

  let pendingApproval: PendingCliApproval | undefined;
  let pendingOutcome: PendingCliOutcome | undefined;
  const runtime = createBundledAgentRuntime({
    projectDirectory,
    interactive: true,
    autoStartMcp: true,
  });
  const projectSettingsPath = () => runtime.projectSettingsPath();
  const globalConfigPath = () => runtime.globalConfigPath();
  let availableModels: LlmCatalogModel[] = [];
  let selectedModel: LlmCatalogModel | undefined;
  let selectedModelSelection: LlmModelSelection | undefined;
  let startupWarning: string | undefined;
  try {
    await runtime.ready();
    const discovery = await discoverCliModels(runtime);
    availableModels = discovery.models;
    startupWarning = discovery.failures[0];
    selectedModel = resolveCliModelSelection(availableModels, options.model);
    selectedModelSelection = selectedModel
      ? { connectionId: selectedModel.connectionId, modelId: selectedModel.modelId }
      : undefined;
  } catch (error) {
    if (!(error instanceof ProjectSettingsValidationError) && !(error instanceof GlobalConfigValidationError)) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
    startupWarning = error.message;
    availableModels = [];
    selectedModel = undefined;
    selectedModelSelection = undefined;
  }

  const cli = createInterface({
    input,
    output,
    terminal: Boolean((input as NodeJS.ReadStream).isTTY),
    prompt: `${paint(output, 'cyan', 'schemanaut')}> `,
  });
  write(
    output,
    [
      `${paint(output, 'cyan', 'SchemaNaut Agent CLI')}`,
      `项目: ${projectDirectory}`,
      selectedModel
        ? modelSummary(selectedModel, runtime.listLlmConnections())
        : availableModels.length > 0
          ? `模型: 已发现 ${availableModels.length} 个生成模型，尚未选择；运行 /model list 后选择。`
          : `模型: 尚未选择模型；请先编辑全局配置 ${globalConfigPath()}，再运行 /models。`,
      ...(startupWarning ? [`配置或模型提示: ${startupWarning}`] : []),
      '数据库：按需启用（不影响通用 Agent 使用）',
      '输入 /help 查看命令；普通输入会交给 Agent。',
      '',
    ].join('\n'),
  );

  let sessionId: string | undefined;
  let activeRun = false;
  let activeRunHandle: AgentRunHandle | undefined;
  let lastRunHandle: AgentRunHandle | undefined;
  let pendingQuestion: PendingCliQuestion | undefined;
  let questionRefreshRevision = 0;
  let preparationController: AbortController | undefined;
  const trace = new CliTraceRenderer(output);
  const steeringBeforeSession: string[] = [];

  const refreshCliQuestion = async (handle: AgentRunHandle, preferred?: PendingCliQuestion): Promise<void> => {
    if (activeRunHandle !== handle) return;
    const revision = ++questionRefreshRevision;
    const requests = await handle.pendingQuestions();
    if (activeRunHandle !== handle || revision !== questionRefreshRevision) return;
    const request = requests[0];
    if (request === undefined) { if (pendingQuestion?.handle === handle) pendingQuestion = undefined; return; }
    const matches = (pending: PendingCliQuestion | undefined) => pending?.handle === handle && pending.request.invocationId === request.invocationId && pending.request.questionId === request.questionId && pending.request.questionRevision === request.questionRevision;
    if (matches(pendingQuestion)) return;
    pendingQuestion = matches(preferred) ? preferred : { request, answers: [], index: 0, commandId: randomUUID(), handle };
    if (pendingQuestion) renderPendingCliQuestion(output, pendingQuestion);
  };

  const showPrompt = () => {
    if (!activeRun && !pendingApproval && !pendingOutcome && !pendingQuestion) cli.prompt();
  };

  const keypressInput = input as NodeJS.ReadStream;
  const onKeypress = (_value: string, key: { ctrl?: boolean; name?: string } | undefined) => {
    if (!key?.ctrl || key.name !== 'o') return;
    if (trace.toggle() && !activeRun && !pendingApproval && !pendingOutcome && !pendingQuestion) cli.prompt(true);
  };
  if (keypressInput.isTTY) keypressInput.on('keypress', onKeypress);

  cli.on('SIGINT', () => {
    if (activeRun) {
      if (activeRunHandle) {
        void activeRunHandle.cancel('Cancelled from the CLI.').catch((error: unknown) => {
          write(output, `${paint(output, 'red', '取消失败')}: ${formatCliError(error)}\n`);
        });
      } else {
        preparationController?.abort();
      }
      write(output, '\n正在取消当前执行；会话记录会保留。\n');
      return;
    }
    cli.close();
  });

  cli.on('line', (rawLine) => {
    const line = rawLine.trim();
    if (pendingQuestion) {
      const pending = pendingQuestion;
      if (pending.submitting) { write(output, '正在提交当前问题，请稍候。\n'); return; }
      if (line === '/cancel') {
        pending.submitting = true;
        void pending.handle.cancelQuestion({
          invocationId: pending.request.invocationId,
          questionId: pending.request.questionId,
          questionRevision: pending.request.questionRevision,
          reason: 'Cancelled from the CLI.',
          clientRequestId: `cli-question-cancel:${pending.commandId}`,
        }).then(async () => {
          if (pendingQuestion === pending) pendingQuestion = undefined;
          await refreshCliQuestion(pending.handle);
        }, async (error: unknown) => {
          pending.submitting = false;
          if (pendingQuestion === pending) pendingQuestion = undefined;
          await refreshCliQuestion(pending.handle, pending);
          if (activeRunHandle === pending.handle) write(output, `${paint(output, 'red', '取消问题失败')}: ${formatCliError(error)}\n`);
        }).catch((error: unknown) => { if (activeRunHandle === pending.handle) write(output, `无法刷新当前问题: ${formatCliError(error)}\n`); });
        return;
      }
      const submit = () => {
        pending.submitting = true;
        void pending.handle.answerQuestion({
          invocationId: pending.request.invocationId,
          questionId: pending.request.questionId,
          questionRevision: pending.request.questionRevision,
          answers: pending.answers,
          clientRequestId: pending.commandId,
        }).then(
          async () => {
            if (pendingQuestion === pending) pendingQuestion = undefined;
            if (activeRunHandle === pending.handle) write(output, `${paint(output, 'dim', '已提交回答；Agent 将继续执行')}\n`);
            await refreshCliQuestion(pending.handle);
          },
          async (error: unknown) => {
            pending.submitting = false;
            if (pendingQuestion === pending) pendingQuestion = undefined;
            await refreshCliQuestion(pending.handle, pending);
            if (activeRunHandle === pending.handle) write(output, `${paint(output, 'red', '提交回答失败')}: ${formatCliError(error)}\n`);
          },
        ).catch((error: unknown) => { if (activeRunHandle === pending.handle) write(output, `无法刷新当前问题: ${formatCliError(error)}\n`); });
      };
      if (pending.index >= pending.request.questions.length) {
        if (line === '/retry') submit();
        else renderPendingCliQuestion(output, pending);
        return;
      }
      const question = pending.request.questions[pending.index]!;
      const answer = cliQuestionAnswer(question, line);
      if (answer === undefined || Buffer.byteLength(JSON.stringify([...pending.answers, answer]), 'utf8') > 6 * 1024) {
        write(output, '回答不能为空、单题不能超过 512 字符，且所有答案总计不能超过 6 KiB。请重新输入当前题。\n');
        renderPendingCliQuestion(output, pending);
        return;
      }
      pending.answers.push(answer);
      pending.index += 1;
      if (pending.index < pending.request.questions.length) renderPendingCliQuestion(output, pending);
      else submit();
      return;
    }
    if (pendingApproval) {
      const approval = pendingApproval;
      pendingApproval = undefined;
      const decision = classifyCliApprovalInput(line);
      void (async () => {
        if (decision === 'approve') {
          await approval.handle.approve({ approvalId: approval.approvalId, decision: 'approve' });
          write(output, `${paint(output, 'dim', '已批准本次操作')}\n`);
          return;
        }
        await approval.handle.approve({ approvalId: approval.approvalId, decision: 'deny' });
        if (decision === 'steer') {
          await approval.handle.steer({ message: line });
          write(output, `${paint(output, 'dim', '已拒绝原操作，并更新当前任务')}\n`);
        } else {
          write(output, `${paint(output, 'dim', '已拒绝本次操作')}\n`);
        }
      })().catch((error: unknown) => {
        pendingApproval ??= approval;
        write(output, `${paint(output, 'red', '处理许可失败')}: ${formatCliError(error)}\n`);
        write(output, '输入 y 本次允许，n 拒绝；也可直接输入新的任务要求 > ');
      });
      return;
    }
    if (pendingOutcome) {
      const decision = classifyCliOutcomeInput(line);
      if (decision === 'invalid') {
        write(output, '请输入 s 确认成功，f 确认失败，或 r 明确承担风险后重试 > ');
        return;
      }
      const outcome = pendingOutcome;
      pendingOutcome = undefined;
      void submitCliOutcomeDecision(outcome.handle, {
        invocationId: outcome.invocationId,
        decision,
        riskyRetryClientRequestId: outcome.riskyRetryClientRequestId,
      }).then(
        () => write(
          output,
          `${paint(
            output,
            'dim',
            decision === 'retry'
              ? '已持久化风险重试授权；Agent 将在下一轮重新规划'
              : `已确认外部操作${decision === 'succeeded' ? '成功' : '失败'}`,
          )}\n`,
        ),
        (error: unknown) => {
          pendingOutcome ??= outcome;
          write(output, `${paint(output, 'red', '确认外部操作结果失败')}: ${formatCliError(error)}\n`);
          write(output, '请输入 s 确认成功，f 确认失败，或 r 明确承担风险后重试 > ');
        },
      );
      return;
    }
    if (!line) {
      showPrompt();
      return;
    }
    if (activeRun) {
      if (line === '/compact' && activeRunHandle) {
        void activeRunHandle.compact().then(
          () => write(output, `${paint(output, 'dim', '已请求压缩当前 Run 上下文')}\n`),
          (error: unknown) => write(output, `${paint(output, 'red', '压缩失败')}: ${formatCliError(error)}\n`),
        );
      } else if (line === '/cancel' && activeRunHandle) {
        void activeRunHandle.cancel('Cancelled from the CLI.').catch((error: unknown) => {
          write(output, `${paint(output, 'red', '取消失败')}: ${formatCliError(error)}\n`);
        });
      } else if (line === '/trace on' || line === '/trace off') {
        trace.setEnabled(line.endsWith('on'));
        write(output, `执行轨迹已${trace.isEnabled() ? '开启' : '关闭'}。\n`);
      } else if (activeRunHandle) {
        void activeRunHandle.steer({ message: line }).catch((error: unknown) => {
          write(output, `${paint(output, 'red', '追加要求失败')}: ${formatCliError(error)}\n`);
        });
        write(output, `${paint(output, 'dim', '已补充到当前任务')}\n`);
      } else {
        steeringBeforeSession.push(line);
        write(output, `${paint(output, 'dim', '将在会话建立后补充')}\n`);
      }
      return;
    }
    void handleLine(line).catch((error: unknown) => {
      trace.clearBeforeFinal();
      write(
        output,
        `${paint(output, 'red', '错误')}: ${formatCliError(error)}\n`,
      );
      activeRun = false;
      activeRunHandle = undefined;
      pendingApproval = undefined;
      pendingOutcome = undefined;
      pendingQuestion = undefined;
      preparationController = undefined;
      steeringBeforeSession.length = 0;
      showPrompt();
    });
  });

  async function handleLine(line: string): Promise<void> {
    if (line.startsWith('/')) {
      const [command = '', ...argumentsList] = line.split(/\s+/);
      const argument = argumentsList.join(' ');
      if (command === '/exit' || command === '/quit') {
        cli.close();
        return;
      }
      if (command === '/help') {
        write(output, cliHelp());
        showPrompt();
        return;
      }
      if (command === '/models') {
        const refreshed = await discoverCliModels(runtime);
        availableModels = refreshed.models;
        selectedModel = selectedModelSelection
          ? resolveCliModelSelection(availableModels, selectedModelSelection)
          : undefined;
        write(
          output,
          availableModels.length > 0
            ? `${renderModelCatalog(
                availableModels,
                selectedModelSelection,
                runtime.listLlmConnections(),
              )}\n`
            : `没有发现生成模型。${
                refreshed.failures.length > 0
                  ? ` ${refreshed.failures.join('；')}`
                  : ` 请检查全局配置 ${globalConfigPath()}。`
              }\n`,
        );
        showPrompt();
        return;
      }
      if (command === '/new') {
        sessionId = undefined;
        lastRunHandle = undefined;
        selectedModel = undefined;
        selectedModelSelection = undefined;
        write(output, '已开始一个全新的隔离会话；新会话尚未选择模型。\n');
        showPrompt();
        return;
      }
      if (command === '/resume') {
        if (!argument) throw new Error('用法：/resume <session-id>');
        const session = await runtime.getAgentSession(argument);
        if (!session) throw new Error(`未找到会话：${argument}`);
        sessionId = session.sessionId;
        lastRunHandle = undefined;
        if (session.model) {
          selectedModelSelection = {
            connectionId: session.model.connectionId,
            modelId: session.model.modelId,
          };
          selectedModel = resolveCliModelSelection(availableModels, selectedModelSelection);
        } else {
          selectedModelSelection = undefined;
          selectedModel = undefined;
        }
        write(
          output,
          `已恢复会话：${session.title ?? '未命名会话'} (${session.sessionId})${
            session.model ? `\n${selectedModel ? modelSummary(selectedModel, runtime.listLlmConnections()) : `模型: ${session.model.modelId}（当前目录未发现）`}` : '\n该会话尚未选择模型。'
          }\n`,
        );
        showPrompt();
        return;
      }
      if (command === '/sessions') {
        const sessions = (await runtime.listAgentSessions({ limit: 30 })).items;
        write(
          output,
          sessions.length === 0
            ? '暂无会话。\n'
            : `${sessions
                .map((session) => `${session.sessionId}  ${session.archived ? 'archived' : 'active'}  ${session.title ?? '未命名会话'}`)
                .join('\n')}\n`,
        );
        showPrompt();
        return;
      }
      if (command === '/skills') {
        const [action = 'list', ...skillParts] = argumentsList;
        if (action === 'reload') {
          const refreshed = await runtime.refreshSkills();
          write(
            output,
            `Skills 已重新加载：${refreshed.skills.length} 个可用，${refreshed.issues.length} 个问题，${refreshed.conflicts.length} 个覆盖。\n`,
          );
          showPrompt();
          return;
        }
        if (action === 'info') {
          const lookup = skillParts.join(' ').trim();
          if (!lookup) throw new Error('用法：/skills info <name|scope:name>');
          const parsed = parseCliSkillLookup(lookup);
          const skill = await runtime.inspectAgentSkill(
            typeof parsed === 'string' ? { name: parsed } : parsed,
          );
          if (!skill) throw new Error(`未找到 Skill：${lookup}`);
          write(
            output,
            [
              `Skill: ${skill.scope}:${skill.name}`,
              `说明: ${skill.description}`,
              `文件: ${skill.sourcePath}`,
            ].join('\n') + '\n',
          );
          showPrompt();
          return;
        }
        if (action !== 'list') throw new Error('用法：/skills [list|reload|info <name>]');
        const skills = await runtime.listAgentSkills();
        write(output, skills.length === 0 ? '没有可用 Skills。\n' : `${skills
          .map((skill) => `/${skill.scope}:${skill.name}  ${skill.description}`)
          .join('\n')}\n`);
        showPrompt();
        return;
      }
      if (command === '/model') {
        if (!argument || argument === 'list') {
          if (availableModels.length === 0) {
            write(output, `没有可选模型。请检查全局配置 ${globalConfigPath()}，再运行 /models。\n`);
          } else {
            write(
              output,
              `${renderModelCatalog(
                availableModels,
                selectedModelSelection,
                runtime.listLlmConnections(),
              )}\n`,
            );
          }
          showPrompt();
          return;
        }
        if (argument === 'current') {
          if (!selectedModelSelection) {
            write(output, `${sessionId ? '当前 Session' : '新会话'}尚未选择模型。\n`);
            showPrompt();
            return;
          }
          const catalogModel =
            resolveCliModelSelection(availableModels, selectedModelSelection) ?? selectedModel;
          let configuration: string;
          if (sessionId) {
            const effective = await runtime.effectiveSessionParameters(sessionId);
            configuration = formatEffectiveConfiguration(
              effective.effectiveParameters,
              effective.contextTokens,
            );
          } else {
            const preview = await runtime.previewModelParameters(selectedModelSelection);
            configuration = formatEffectiveConfiguration(
              preview.effectiveParameters,
              catalogModel?.contextTokens ?? preview.contextTokens,
            );
          }
          write(
            output,
            `${catalogModel ? modelSummary(catalogModel, runtime.listLlmConnections()) : `模型: ${selectedModelSelection.modelId}`}\n${configuration}\n`,
          );
          showPrompt();
          return;
        }
        const next = selectCliModel(availableModels, argument);
        selectedModel = next;
        selectedModelSelection = {
          connectionId: next.connectionId,
          modelId: next.modelId,
        };
        if (sessionId) {
          await runtime.selectSessionModel({ sessionId, model: selectedModelSelection });
        }
        write(
          output,
          `${sessionId ? '当前 Session' : '待创建 Session'}模型已选择：${modelSummary(
            selectedModel,
            runtime.listLlmConnections(),
          )}\n`,
        );
        showPrompt();
        return;
      }
      if (command === '/settings') {
        const action = argument || 'show';
        if (action === 'path') {
          write(output, `${projectSettingsPath()}（仅 MCP 项目设置）\n`);
          showPrompt();
          return;
        }
        if (action !== 'show' && action !== 'validate') {
          throw new Error('用法：/settings [show|path|validate]');
        }
        const settings = await runtime.reloadProjectSettings();
        if (action === 'validate') {
          write(
            output,
            settings.exists
              ? `项目 MCP settings.json 校验通过：${projectSettingsPath()}\n`
              : `项目 MCP settings.json 尚未创建：${projectSettingsPath()}\n`,
          );
        } else {
          const mcpServers = await runtime.listMcpServers();
          write(output, `${renderCliSettings(settings, projectSettingsPath(), mcpServers)}\n`);
        }
        showPrompt();
        return;
      }
      if (command === '/config') {
        const action = argument || 'show';
        if (action === 'path') {
          write(output, `${globalConfigPath()}（全局模型与企业权限配置）\n`);
          showPrompt();
          return;
        }
        if (action !== 'show' && action !== 'validate') {
          throw new Error('用法：/config [show|path|validate]');
        }
        const config = await runtime.reloadGlobalConfig();
        write(
          output,
          action === 'validate'
            ? config.exists
              ? `全局 config.toml 校验通过：${globalConfigPath()}\n`
              : `全局 config.toml 尚未创建，将使用安全默认值：${globalConfigPath()}\n`
            : `${renderGlobalConfig(config)}\n`,
        );
        showPrompt();
        return;
      }
      if (command === '/doctor') {
        const refreshed = await discoverCliModels(runtime);
        availableModels = refreshed.models;
        selectedModel = selectedModelSelection
          ? resolveCliModelSelection(availableModels, selectedModelSelection)
          : undefined;
        const settings = await runtime.getGlobalConfig();
        const skillRefresh = await runtime.refreshSkills();
        const mcpServers = await runtime.listMcpServers();
        write(
          output,
          `${renderCliDoctor(settings, refreshed, {
            globalConfigPath: globalConfigPath(),
            skillCount: skillRefresh.skills.length,
            skillIssueCount: skillRefresh.issues.length,
            mcpServers,
          })}\n`,
        );
        showPrompt();
        return;
      }
      if (command === '/compact') {
        if (argument) throw new Error('/compact 不接受参数。');
        if (!lastRunHandle) throw new Error('当前还没有可压缩的 Run。');
        await lastRunHandle.compact();
        write(output, '已请求压缩当前 Run 的上下文；完整历史仍会保留。\n');
        showPrompt();
        return;
      }
      if (command === '/trace') {
        if (!['on', 'off'].includes(argument)) {
          throw new Error('/trace 只接受 on 或 off。');
        }
        trace.setEnabled(argument === 'on');
        write(output, `执行轨迹已${trace.isEnabled() ? '开启' : '关闭'}。\n`);
        showPrompt();
        return;
      }
      if (command === '/mcp') {
        const [action = 'list', serverId] = argumentsList;
        if (action === 'start') {
          if (!serverId) throw new Error('用法：/mcp start <server-id>');
          const started = await runtime.startMcpServer(serverId);
          write(
            output,
            `${serverId}: ${started.server.status}，发现 ${started.tools.length} 个工具。\n`,
          );
          showPrompt();
          return;
        }
        if (action === 'stop') {
          if (!serverId) throw new Error('用法：/mcp stop <server-id>');
          const stopped = await runtime.stopMcpServer(serverId);
          write(
            output,
            `${serverId}: ${stopped.status}，已移除 ${stopped.removedTools.length} 个工具。\n`,
          );
          showPrompt();
          return;
        }
        const servers = await runtime.listMcpServers();
        if (action === 'doctor') {
          write(output, `${renderMcpDoctor(servers, projectSettingsPath())}\n`);
          showPrompt();
          return;
        }
        if (action !== 'list') {
          throw new Error('用法：/mcp [list|start <id>|stop <id>|doctor]');
        }
        write(
          output,
          servers.length === 0
            ? `尚未配置 MCP Server；请编辑项目设置 ${projectSettingsPath()} 中的 mcp.servers。\n`
            : `${servers
                .map(
                  (server) =>
                    `${server.id.padEnd(24)} ${server.status.padEnd(11)} ${server.transport}${
                      server.running ? '  运行中' : ''
                    }`,
                )
                .join('\n')}\n`,
        );
        showPrompt();
        return;
      }
      if (command === '/run') {
        const [action, runId, ...extra] = argumentsList;
        if (action !== 'resume' || !runId || extra.length > 0) {
          throw new Error('用法：/run resume <run-id>');
        }
        activeRun = true;
        trace.start();
        const handle = await resumeCliRun(runtime, runId);
        await renderCliRun(handle);
        return;
      }
      if (['/agent', '/init', '/permissions', '/session'].includes(command)) {
        throw new Error(`命令 ${command} 尚未在交互模式中提供。`);
      }
      // Other slash commands are standard Skill invocations.
    }

    if (!selectedModelSelection) {
      throw new Error(
        `${sessionId ? '当前 Session' : '新会话'}尚未选择模型。请编辑全局配置 ${globalConfigPath()} 配置 Endpoint，运行 /models，再用 /model 选择。`,
      );
    }
    activeRun = true;
    preparationController = new AbortController();
    trace.start();
    const handle = await runtime.startAgentRun({
      message: line,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(sessionId === undefined ? { model: selectedModelSelection } : {}),
      signal: preparationController.signal,
    });
    preparationController = undefined;
    while (steeringBeforeSession.length > 0) {
      const steering = steeringBeforeSession.shift();
      if (steering) await handle.steer({ message: steering });
    }
    await renderCliRun(handle);
  }

  async function renderCliRun(handle: AgentRunHandle): Promise<void> {
    activeRunHandle = handle;
    lastRunHandle = handle;
    sessionId = handle.sessionId;
    const session = await runtime.getAgentSession(handle.sessionId);
    if (session?.model) {
      selectedModelSelection = {
        connectionId: session.model.connectionId,
        modelId: session.model.modelId,
      };
      selectedModel = resolveCliModelSelection(availableModels, selectedModelSelection);
    } else {
      selectedModelSelection = undefined;
      selectedModel = undefined;
    }
    const subscription = new AbortController();
    try {
      const eventsCompleted = consumeCliRunEvents(
        handle,
        trace,
        subscription.signal,
        (approvalId) => {
          pendingApproval = { approvalId, handle };
          write(output, '输入 y 本次允许，n 拒绝；也可直接输入新的任务要求 > ');
        },
        (invocationId) => {
          pendingOutcome = {
            invocationId,
            riskyRetryClientRequestId: randomUUID(),
            handle,
          };
          write(
            output,
            '外部操作结果未知；输入 s 确认成功，f 确认失败，或 r 明确承担风险后重试 > ',
          );
        },
        async () => { await refreshCliQuestion(handle); },
      );
      const [result] = await Promise.all([handle.result(), eventsCompleted.then(() => undefined)]);
      if (pendingApproval?.handle === handle) pendingApproval = undefined;
      trace.clearBeforeFinal();
      const outcome = formatCliRunOutcome(result);
      write(output, `\n${paint(output, outcome.tone, outcome.heading)}\n${outcome.body}\n`);
      if (result.finalContentRef) {
        write(output, `${paint(output, 'cyan', '产物')}: ${result.finalContentRef}\n`);
      }
      write(
        output,
        `${paint(output, 'dim', `Run ${result.runId} · Session ${result.sessionId} · ${result.status}`)}\n`,
      );
    } finally {
      subscription.abort();
      activeRun = false;
      activeRunHandle = undefined;
      pendingApproval = undefined;
      pendingOutcome = undefined;
      pendingQuestion = undefined;
      questionRefreshRevision++;
      preparationController = undefined;
    }
    showPrompt();
  }

  return await new Promise<void>((resolveDone) => {
    cli.once('close', () => {
      if (keypressInput.isTTY) keypressInput.removeListener('keypress', onKeypress);
      void runtime
        .close()
        .catch(() => undefined)
        .finally(resolveDone);
    });
    showPrompt();
  });
}

async function consumeCliRunEvents(
  handle: AgentRunHandle,
  trace: CliTraceRenderer,
  signal: AbortSignal,
  onApproval: (approvalId: string) => void,
  onUnknownOutcome: (invocationId: string) => void,
  onQuestion: () => Promise<void>,
): Promise<void> {
  for await (const event of handle.events({ signal })) {
    trace.render(event);
    const detail = activityDetailRecord(event.detail);
    if (
      event.kind === 'approval' &&
      event.phase === 'waiting' &&
      typeof detail?.approvalId === 'string' &&
      detail.approvalId.trim()
    ) {
      onApproval(detail.approvalId);
    } else if (
      event.kind === 'result' &&
      event.phase === 'waiting' &&
      typeof detail?.invocationId === 'string' &&
      detail.invocationId.trim()
    ) {
      onUnknownOutcome(detail.invocationId);
    } else if (
      event.kind === 'tool' &&
      event.phase === 'waiting' &&
      typeof detail?.questionId === 'string'
    ) {
      await onQuestion();
    } else if (event.kind === 'tool' && event.phase !== 'waiting') {
      // Terminal tool activity includes deadline/cancel resolution. Reconcile
      // durable pending state instead of retaining a stale local prompt.
      await onQuestion();
    }
  }
}

export function formatCliError(error: unknown): string {
  if (error instanceof AgentRuntimeError) {
    return `[${error.code}] ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export type CliRunOutcome = Readonly<{
  tone: 'green' | 'yellow' | 'red';
  heading: string;
  body: string;
}>;

/** Produces the durable, user-facing terminal state without exposing Journal internals. */
export function formatCliRunOutcome(result: AgentRunResult): CliRunOutcome {
  const finalText = result.finalText.trim();
  if (result.status === 'completed') {
    return {
      tone: 'green',
      heading: '回答',
      body: finalText,
    };
  }
  if (result.status === 'failed' || result.status === 'interrupted') {
    const diagnostic = formatCliRunDiagnostic(result.error);
    const resumable = result.status === 'interrupted'
      ? `\n可使用 /run resume ${result.runId} 继续。`
      : '';
    return {
      tone: result.status === 'failed' ? 'red' : 'yellow',
      heading: result.status === 'failed' ? '运行失败' : '运行已中断',
      body: `${diagnostic}${finalText ? `\n${finalText}` : ''}${resumable}`,
    };
  }
  if (result.status === 'cancelled') {
    return {
      tone: 'yellow',
      heading: '运行已取消',
      body: finalText || '任务已按用户请求停止。',
    };
  }
  return {
    tone: 'yellow',
    heading: '运行达到上限',
    body: finalText || '本次运行未在限制内完成。',
  };
}

function formatCliRunDiagnostic(error: AgentRunResult['error']): string {
  if (error === undefined) return '[RUN_TERMINATED]';
  const detail = portableRecord(error.detail);
  const causeCode = typeof detail?.code === 'string' && detail.code !== error.code
    ? ` 原因 ${detail.code}`
    : '';
  const statusCode = typeof detail?.statusCode === 'number'
    ? `（HTTP ${detail.statusCode}）`
    : '';
  return `[${error.code}]${causeCode}${statusCode}`;
}

function portableRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function cliHelp(): string {
  return [
    '',
    '命令',
    '  /settings [show|path]                查看项目 MCP 设置或文件路径（只读）',
    '  /settings validate                   重新读取并严格校验项目 MCP 设置',
    '  /config [show|path|validate]         查看、定位或校验全局模型与企业权限配置',
    '  /models                              从全局配置的 Endpoint 刷新模型目录',
    '  /model [list|current|序号|模型名]    查看或选择当前 Session 模型',
    '  /new                                 新建隔离会话并重新选择模型',
    '  /resume <id>                         恢复会话及其模型',
    '  /run resume <run-id>                 打开并继续被中断或达到限制的 Run',
    '  /sessions                            查看会话',
    '  /skills [list|reload|info]           查看或重新加载 Markdown Skills',
    '  /mcp [list|start|stop|doctor]        查看或控制 MCP 运行状态',
    '  /doctor                              检查 Settings、模型、Skills 与 MCP',
    '  /<skill> [任务]                      显式执行 Skill',
    '  /compact                             手动压缩当前 Run 上下文',
    '  /cancel                              显式取消当前 Run',
    '  /trace on|off                        显示或隐藏执行轨迹（默认开启）',
    '  /exit                                退出',
    '',
    'Agent 工作时继续输入普通文字，会作为补充要求加入当前任务；Ctrl+O 展开/收起轨迹，Ctrl+C 取消当前执行。',
    '',
  ].join('\n');
}

function modelSummary(
  model: LlmCatalogModel,
  connections: readonly LlmConnectionSummary[] = [],
): string {
  const context = model.contextTokens.value;
  const maxInput = model.maxInputTokens.value;
  const connection = connections.find((item) => item.id === model.connectionId);
  return [
    `模型: ${model.modelId}`,
    ...(connection ? [`Endpoint: ${connection.name}`] : []),
    `上下文: ${context === null || context === undefined ? '未知' : `${context} tokens`}`,
    ...(maxInput === null || maxInput === undefined ? [] : [`最大输入: ${maxInput} tokens`]),
    `元数据: ${model.contextTokens.source}`,
  ].join(' · ');
}

type CliModelDiscovery = {
  models: LlmCatalogModel[];
  failures: string[];
};

async function discoverCliModels(runtime: AgentRuntime): Promise<CliModelDiscovery> {
  await runtime.reloadGlobalConfig();
  const connections = runtime.status().connections;
  if (connections.length === 0) return { models: [], failures: [] };
  const results = await Promise.allSettled(
    connections.map((connection) =>
      runtime.discoverLlmConnection({ connectionId: connection.id }),
    ),
  );
  const models = runtime.listLlmModels({ role: 'generation' });
  const failures = results.flatMap((result, index) => {
    if (result.status !== 'rejected') return [];
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return [`${connections[index]?.name ?? '连接'}: ${reason}`];
  });
  return { models, failures };
}

function formatEffectiveConfiguration(
  effective: LlmEffectiveParameters,
  context?: LlmMetadataValue<number>,
): string {
  const entries = Object.entries(effective.values);
  const parameters =
    entries.length === 0
      ? ['参数: Provider/模型默认值']
      : entries.map(
          ([name, value]) =>
            `${name}: ${JSON.stringify(value)} (${effective.sources[name as keyof typeof effective.sources] ?? 'provider-default'})`,
        );
  return [
    ...parameters,
    `上下文: ${
      context?.value === null || context?.value === undefined
        ? '未知'
        : `${context.value} tokens (${context.source})`
    }`,
    ...effective.diagnostics.map((item) => `提示: ${item.message}`),
  ].join('\n');
}

function renderCliDoctor(
  settings: GlobalConfigView,
  discovery: CliModelDiscovery,
  diagnostics: {
    globalConfigPath: string;
    skillCount: number;
    skillIssueCount: number;
    mcpServers: readonly McpServerSummary[];
  },
): string {
  const unknownContext = discovery.models.filter((model) => model.contextTokens.value === null).length;
  const unhealthyMcp = diagnostics.mcpServers.filter(
    (server) => server.running && !server.healthy,
  ).length;
  return [
    `全局配置: ${settings.exists ? '已加载并通过校验' : '尚未创建'} (${diagnostics.globalConfigPath})`,
    `Endpoint: ${settings.connections.length}`,
    `生成模型: ${discovery.models.length}`,
    `上下文未知: ${unknownContext}`,
    `Skills: ${diagnostics.skillCount} 个可用，${diagnostics.skillIssueCount} 个问题`,
    `MCP: ${diagnostics.mcpServers.length} 个已配置，${diagnostics.mcpServers.filter((server) => server.running).length} 个运行中，${unhealthyMcp} 个异常`,
    ...(discovery.failures.length === 0
      ? ['发现错误: 0']
      : discovery.failures.map((failure) => `发现错误: ${failure}`)),
  ].join('\n');
}

function renderCliSettings(
  settings: Readonly<{ exists: boolean }>,
  settingsPath: string,
  mcpServers: readonly McpServerSummary[],
): string {
  return [
    `项目 MCP 设置文件: ${settingsPath}`,
    `状态: ${settings.exists ? '已加载' : '尚未创建'}`,
    `MCP Server: ${mcpServers.length}`,
    '模型连接和默认参数仅来自全局 config.toml；模型选择属于 Session。',
  ].join('\n');
}

function renderGlobalConfig(config: GlobalConfigView): string {
  return [
    `全局配置文件: ${config.path}`,
    `状态: ${config.exists ? '已加载' : '尚未创建（使用安全默认值）'}`,
    `模型连接: ${config.connections.length}`,
    `默认权限模式: ${config.permissionMode}`,
    `企业权限规则: ${config.permissionRules.length}`,
    `默认生成参数: ${Object.keys(config.parameters).length}`,
    '密钥值不会显示；配置仅保存环境变量名或安全存储引用。',
  ].join('\n');
}

function renderMcpDoctor(
  servers: readonly McpServerSummary[],
  settingsPath: string,
): string {
  if (servers.length === 0) {
    return `MCP: 尚未配置。请编辑 ${settingsPath} 中的 mcp.servers。`;
  }
  return [
    `MCP 配置: ${servers.length} 个`,
    ...servers.map((server) =>
      [
        `${server.id}: ${server.status}`,
        `transport=${server.transport}`,
        server.running ? '运行中' : '未运行',
        ...server.warnings.map((warning) => `提示=${warning}`),
      ].join(' · '),
    ),
  ].join('\n');
}

function parseCliSkillLookup(
  value: string,
): string | { name: string; scope: 'system' | 'user' | 'project' | 'session' } {
  const match = /^(system|user|project|session):(.+)$/.exec(value.trim());
  if (!match) return value.trim();
  return {
    scope: match[1] as 'system' | 'user' | 'project' | 'session',
    name: match[2]!.trim(),
  };
}

function resolveCliModelSelection(
  models: readonly LlmCatalogModel[],
  selection: LlmModelSelection | undefined,
): LlmCatalogModel | undefined {
  if (!selection) return undefined;
  return models.find(
    (model) =>
      model.connectionId === selection.connectionId && model.modelId === selection.modelId,
  );
}

function selectCliModel(models: readonly LlmCatalogModel[], argument: string): LlmCatalogModel {
  const index = Number(argument);
  if (Number.isSafeInteger(index) && index >= 1 && index <= models.length) {
    return models[index - 1]!;
  }
  const matches = models.filter(
    (model) => model.modelId === argument || `${model.connectionId}/${model.modelId}` === argument,
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error('多个连接提供同名模型，请使用 /model 后显示的序号切换。');
  }
  throw new Error(`未找到模型：${argument}。使用 /model list 查看可用模型。`);
}

function renderModelCatalog(
  models: readonly LlmCatalogModel[],
  selected: LlmModelSelection | undefined,
  connections: readonly LlmConnectionSummary[] = [],
): string {
  return models
    .map((model, index) => {
      const active =
        model.connectionId === selected?.connectionId && model.modelId === selected?.modelId;
      const context = model.contextTokens.value;
      const connection = connections.find((item) => item.id === model.connectionId);
      return `${active ? '*' : ' '} ${String(index + 1).padStart(2)}  ${model.modelId}  ${
        context === null ? '上下文未知' : `${context} tokens`
      }  (${connection?.name ?? model.connectionId} · ${model.contextTokens.source})`;
    })
    .join('\n');
}

function paint(
  output: Writable,
  color: 'cyan' | 'green' | 'yellow' | 'red' | 'dim',
  value: string,
): string {
  if (!(output as NodeJS.WriteStream).isTTY) return value;
  const codes = {
    cyan: 36,
    green: 32,
    yellow: 33,
    red: 31,
    dim: 2,
  };
  return `\u001B[${codes[color]}m${value}\u001B[0m`;
}

function write(output: Writable, value: string): void {
  output.write(value);
}

function isTtyOutput(output: Writable): boolean {
  return (output as NodeJS.WriteStream).isTTY === true;
}

function terminalColumns(output: Writable): number {
  const columns = (output as NodeJS.WriteStream).columns;
  return Number.isSafeInteger(columns) && columns > 0 ? columns : 120;
}

function renderedTerminalLines(value: string, columns: number): number {
  return stripVTControlCharacters(value)
    .split('\n')
    .slice(0, -1)
    .reduce((total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / columns)), 0);
}

function displayWidth(value: string): number {
  return [...value].reduce(
    (width, character) =>
      width + (/[\u1100-\u115f\u2e80-\u9fff\uac00-\ud7a3]/u.test(character) ? 2 : 1),
    0,
  );
}
