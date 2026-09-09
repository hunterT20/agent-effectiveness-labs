import pathPosix from 'node:path/posix';
import pathWin32 from 'node:path/win32';

function pathApiFor(child: string, parent: string): typeof pathPosix {
  if (child.includes('\\') || parent.includes('\\')) {
    return pathWin32;
  }
  return pathPosix;
}

/**
 * Returns true when `child` is the same path as `parent` or lies strictly inside `parent`.
 * Uses `path.relative` so containment works on Windows drive letters and mixed separators.
 */
export function isInside(child: string, parent: string): boolean {
  const pathApi = pathApiFor(child, parent);
  const resolvedChild = pathApi.resolve(child);
  const resolvedParent = pathApi.resolve(parent);
  const relativePath = pathApi.relative(resolvedParent, resolvedChild);

  return (
    relativePath === '' || (!relativePath.startsWith('..') && !pathApi.isAbsolute(relativePath))
  );
}
