import { minimatch } from 'minimatch';

export function matchesModule(file, patterns) {
  return patterns.some(pattern => minimatch(file, pattern, { dot: true }));
}

export function moduleOwners(file, policy) {
  return policy.owners.filter(owner => matchesModule(file, owner.sources));
}

export function sourceModule(file, policy) {
  return policy.sourceRoots.some(root => file.startsWith(`${root}/`));
}
