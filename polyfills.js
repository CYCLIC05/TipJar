import { Buffer } from 'buffer';

// Ensure browser global compatibility for libraries expecting Node globals
if (typeof window !== 'undefined') {
  if (!window.Buffer) window.Buffer = Buffer;
  if (!window.process) window.process = { env: { NODE_ENV: 'development' } };
  if (!window.global) window.global = window;
}
