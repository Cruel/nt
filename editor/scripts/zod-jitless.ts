import { z } from 'zod';

// Perry is an AOT runtime. Configure Zod before the CLI module graph creates
// schemas so it never probes dynamic Function support or writes AOT warnings.
z.config({ jitless: true });
