/** Re-run the idempotent seed against the existing database. */
import { migrate } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';

migrate();
const result = seed();
console.log(result.seeded ? `Seeded ${result.accounts} accounts and ${result.users} users.` : 'Reference data is up to date; demo data already present.');
