/** Opaque references are the only browser identities exposed to Tools and the Agent. */
export type BrowserSessionRef = string & { readonly __browserSessionRef: unique symbol };
export type BrowserPageRef = string & { readonly __browserPageRef: unique symbol };

export type BrowserOperationContext = Readonly<{
  signal?: AbortSignal;
  /** Absolute ISO deadline owned by the Host invocation. */
  deadline?: string;
}>;

export type BrowserSessionProbe = Readonly<{
  status: 'available' | 'unavailable';
  browser?: string;
  reason?: string;
}>;

export type BrowserPageSummary = Readonly<{
  pageRef: BrowserPageRef;
  url: string;
  title: string;
}>;

export type BrowserSessionConnection = Readonly<{
  sessionRef: BrowserSessionRef;
  pages: readonly BrowserPageSummary[];
}>;

export type BrowserElementSummary = Readonly<{
  selector: string;
  role?: string;
  text?: string;
  disabled?: boolean;
}>;

export type BrowserPageContent = Readonly<{
  sessionRef: BrowserSessionRef;
  pageRef: BrowserPageRef;
  url: string;
  title: string;
  text: string;
  elements: readonly BrowserElementSummary[];
  truncated: boolean;
}>;

export type BrowserInteraction = Readonly<{
  kind: 'type' | 'press' | 'select' | 'check' | 'uncheck' | 'focus';
  selector: string;
  value?: string;
}>;

export type BrowserActionResult = Readonly<{
  sessionRef: BrowserSessionRef;
  pageRef: BrowserPageRef;
  url: string;
  title: string;
}>;

export type BrowserScreenshot = BrowserActionResult & Readonly<{
  mediaType: 'image/png';
  bytes: Uint8Array;
}>;

export type BrowserSessionErrorKind =
  | 'invalid_argument'
  | 'not_found'
  | 'precondition'
  | 'external'
  | 'timeout'
  | 'cancelled';

export class BrowserSessionError extends Error {
  constructor(
    readonly kind: BrowserSessionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

/**
 * Host-owned browser authority. Intentionally has no Cookie, header, storage,
 * endpoint, or arbitrary CDP method. Implementations keep the authenticated
 * browser session entirely on the execution side.
 */
export interface BrowserSessionPort {
  probe(context?: BrowserOperationContext): Promise<BrowserSessionProbe>;
  connect(context?: BrowserOperationContext): Promise<BrowserSessionConnection>;
  navigate(pageRef: BrowserPageRef | undefined, url: string, context?: BrowserOperationContext): Promise<BrowserActionResult>;
  read(pageRef: BrowserPageRef, context?: BrowserOperationContext): Promise<BrowserPageContent>;
  click(pageRef: BrowserPageRef, selector: string, context?: BrowserOperationContext): Promise<BrowserActionResult>;
  interact(pageRef: BrowserPageRef, interaction: BrowserInteraction, context?: BrowserOperationContext): Promise<BrowserActionResult>;
  screenshot(pageRef: BrowserPageRef, fullPage: boolean, context?: BrowserOperationContext): Promise<BrowserScreenshot>;
  close(context?: BrowserOperationContext): Promise<void>;
}
