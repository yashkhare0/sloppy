import { createRequire } from 'node:module';
import ts from 'typescript';
import { ESLint } from 'eslint';
const require = createRequire(import.meta.url);
export const versions = { cli: require('../../package.json').version, node: process.version, typescript: ts.version, eslint: ESLint.version, pyright: require('pyright/package.json').version };
