#!/usr/bin/env node
// The CLI sources are TypeScript run straight from the checkout: tsx
// registers its loader, then the real module hands over.
import 'tsx';
import process from 'node:process';

const { main } = await import('../src/cli.js');
process.exitCode = await main(process.argv.slice(2));
