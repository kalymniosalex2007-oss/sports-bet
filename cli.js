import 'dotenv/config';
import { runJob, JOBS } from './sync.js';
const j = process.argv[2] || 'daily';
if (!JOBS[j]) { console.error('Διαθέσιμα:', Object.keys(JOBS).join(', ')); process.exit(1); }
await runJob(j, JOBS[j]); console.log('Ολοκληρώθηκε:', j);
