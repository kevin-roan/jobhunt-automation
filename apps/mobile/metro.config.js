// npm workspaces hoist every dependency to the repository root, which is
// outside this project. Metro only watches its project root by default, so
// without these two settings `expo start` cannot resolve react, expo-router or
// anything else installed up there.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

// Project-local first, then the hoisted root. Order matters: a package that
// exists in both must resolve to the copy this app declares.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// The api and web workspaces pull in server-only and browser-only packages that
// must never be walked by the mobile bundler; disabling hierarchical lookup
// keeps resolution to the two paths above.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
