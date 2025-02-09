import { Disposable, disposeAll, workspace } from 'coc.nvim';
import pathLib from 'path';
import { internalEvents, onEvent } from '../events';
import { ExplorerManager } from '../explorerManager';
import { BaseTreeNode, ExplorerSource } from '../source/source';
import {
  Cancelled,
  debounce,
  debouncePromise,
  logger,
  mapGetWithDefault,
  sum,
} from '../util';
import { gitManager } from './manager';
import { GitIgnore, GitMixedStatus, GitRootStatus } from './types';

const statusEqual = (a: GitMixedStatus, b: GitMixedStatus) => {
  return a.x === b.x && a.y === b.y;
};

const rootStatusEqual = (a: GitRootStatus, b: GitRootStatus) => {
  if (a.allStaged !== b.allStaged) {
    return false;
  }
  return a.formats.join(',') === b.formats.join(',');
};

export class GitBinder {
  protected sourcesBinding: Map<
    ExplorerSource<BaseTreeNode<any>>,
    { refCount: number }
  > = new Map();
  /**
   * prevStatuses[root][path] = GitMixedStatus
   */
  private prevStatuses: Record<string, Record<string, GitMixedStatus>> = {};
  /**
   * prevIgnoreStatus[root][path] = GitRootStatus
   */
  private prevIgnores: Record<string, Record<string, GitIgnore>> = {};
  /**
   * prevRootStatus[root] = GitRootStatus
   */
  private prevRootStatus: Record<string, GitRootStatus> = {};
  private registerForSourceDisposables: Disposable[] = [];
  private registerDisposables: Disposable[] = [];
  private inited = false;

  explorerManager_?: ExplorerManager;
  get explorerManager() {
    if (!this.explorerManager_) {
      throw new Error('ExplorerSource(explorerManager) is not bound yet');
    }
    return this.explorerManager_;
  }

  get sources() {
    return Array.from(this.sourcesBinding.keys());
  }

  get refTotalCount() {
    return sum(Array.from(this.sourcesBinding.values()).map((b) => b.refCount));
  }

  protected init_(source: ExplorerSource<BaseTreeNode<any>>) {
    if (!this.inited) {
      this.inited = true;
      this.explorerManager_ = source.explorer.explorerManager;
    }
  }

  bind(source: ExplorerSource<BaseTreeNode<any>>) {
    this.init_(source);
    const binding = mapGetWithDefault(this.sourcesBinding, source, () => ({
      refCount: 0,
    }));
    binding.refCount += 1;
    if (binding.refCount === 1) {
      this.registerForSourceDisposables = this.registerForSource(source);
    }
    if (this.refTotalCount === 1) {
      this.registerDisposables = this.register();
    }
    return Disposable.create(() => {
      binding.refCount -= 1;
      if (binding.refCount === 0) {
        disposeAll(this.registerForSourceDisposables);
        this.registerForSourceDisposables = [];
      }
      if (this.refTotalCount === 0) {
        disposeAll(this.registerDisposables);
        this.registerDisposables = [];
      }
    });
  }

  protected register() {
    return [
      ...(['CocGitStatusChange', 'FugitiveChanged'] as const).map((event) =>
        internalEvents.on(event, async () => {
          await this.reloadDebounce(this.sources, workspace.cwd);
        }),
      ),
      onEvent(
        'BufWritePost',
        debounce(500, async (bufnr) => {
          const fullpath = this.explorerManager.bufManager.getBufferNode(bufnr)
            ?.fullpath;
          if (fullpath) {
            const dirname = pathLib.dirname(fullpath);
            await this.reloadDebounce(this.sources, dirname);
          }
        }),
      ),
    ];
  }

  protected registerForSource(
    source: ExplorerSource<BaseTreeNode<any, string>>,
  ) {
    return [
      source.events.on('loaded', async (node) => {
        const directory =
          'isRoot' in node
            ? source.root
            : node.expandable
            ? node.fullpath
            : node.fullpath && pathLib.dirname(node.fullpath);
        if (directory) {
          this.reloadDebounce([source], directory).catch(logger.error);
        }
      }),
    ];
  }

  protected reloadDebounceChecker = debouncePromise(200, () => {});
  protected reloadDebounceArgs = {
    sources: new Set<ExplorerSource<any>>(),
    directories: new Set<string>(),
  };

  protected async reloadDebounce(
    sources: ExplorerSource<any>[],
    directory: string,
  ) {
    sources.forEach((s) => {
      this.reloadDebounceArgs.sources.add(s);
    });
    this.reloadDebounceArgs.directories.add(directory);
    const r = await this.reloadDebounceChecker();
    if (r instanceof Cancelled) {
      return;
    }
    await this.reload(
      [...this.reloadDebounceArgs.sources],
      [...this.reloadDebounceArgs.directories],
    );
    this.reloadDebounceArgs.sources.clear();
    this.reloadDebounceArgs.directories.clear();
  }

  protected async reload(
    sources: ExplorerSource<any>[],
    directories: string[],
  ) {
    const roots = await gitManager.getGitRoots(directories);

    if (!roots.length) {
      return;
    }

    const updatePaths: Set<string> = new Set();
    const updateDirs: Set<string> = new Set();

    for (const root of roots) {
      await gitManager.reload(root);

      // render paths
      const statuses = gitManager.getMixedStatusesByRoot(root);
      const ignores = gitManager.getIgnoreByRoot(root);
      const rootStatus = gitManager.getRootStatus(root) || {
        allStaged: false,
        formats: [],
      };
      if (!(root in this.prevStatuses)) {
        this.prevStatuses[root] = {};
      }
      if (!(root in this.prevIgnores)) {
        this.prevIgnores[root] = {};
      }
      if (!(root in this.prevRootStatus)) {
        this.prevRootStatus[root] = {
          allStaged: false,
          formats: [],
        };
      }
      const addGitIgnore = (fullpath: string, gitIgnore: GitIgnore) => {
        if (gitIgnore === GitIgnore.directory) {
          updateDirs.add(fullpath.replace(/[\\/]$/, ''));
        } else {
          updatePaths.add(fullpath);
        }
      };

      for (const [fullpath, status] of Object.entries(statuses)) {
        if (fullpath in this.prevStatuses[root]) {
          if (statusEqual(this.prevStatuses[root][fullpath], status)) {
            delete this.prevStatuses[root][fullpath];
            continue;
          }
        }
        updatePaths.add(fullpath);
      }
      for (const fullpath of Object.keys(this.prevStatuses[root])) {
        updatePaths.add(fullpath);
      }

      // ignore
      for (const [fullpath, gitIgnore] of Object.entries(ignores)) {
        if (fullpath in this.prevIgnores[root]) {
          if (this.prevIgnores[root][fullpath] === gitIgnore) {
            delete this.prevIgnores[root][fullpath];
            continue;
          }
        }
        addGitIgnore(fullpath, gitIgnore);
      }
      for (const [fullpath, gitIgnore] of Object.entries(
        this.prevIgnores[root],
      )) {
        addGitIgnore(fullpath, gitIgnore);
      }

      // root
      if (
        rootStatus &&
        (!this.prevRootStatus ||
          !rootStatusEqual(this.prevRootStatus[root], rootStatus))
      ) {
        updatePaths.add(root);
      }

      this.prevStatuses[root] = statuses;
      this.prevIgnores[root] = ignores;
      this.prevRootStatus[root] = rootStatus;
    }

    for (const source of sources) {
      await source.view.renderPaths([
        ...updatePaths,
        {
          paths: updateDirs,
          withChildren: true,
        },
      ]);
    }
  }
}
