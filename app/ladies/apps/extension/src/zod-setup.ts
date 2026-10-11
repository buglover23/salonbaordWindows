import { z } from 'zod';

// Extension pages forbid eval; Zod must never try its JIT. Imported first by every extension entry point.
z.config({ jitless: true });
