#!/usr/bin/env node
import { verifyCallerMain } from './verify-caller.mjs';
await verifyCallerMain(['--caller', 'zcode', ...process.argv.slice(2)]);
