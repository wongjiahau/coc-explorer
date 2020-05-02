import { workspace } from 'coc.nvim';

export const config = workspace.getConfiguration('explorer');

export const getEnableDebug = () => config.get<boolean>('debug')!;

export const getActiveMode = () => config.get<boolean>('activeMode')!;

export const getAutoReveal = () => config.get<boolean>('file.autoReveal')!;

export const getOpenActionForDirectory = () =>
  config.get<string>('openAction.for.directory')!;

export type PreviewStrategy = 'labeling';
export const getPreviewStrategy = () =>
  config.get<PreviewStrategy>('previewAction.strategy')!;

export const getDatetimeFormat = () => config.get<string>('datetime.format')!;

export const getEnableVimDevicons = () =>
  config.get<boolean>('icon.enableVimDevicons')!;

export const getEnableNerdfont = () =>
  config.get<string>('icon.enableNerdfont')!;

export const getEnableFloatingBorder = () =>
  config.get<boolean>('floating.border.enable')!;

export const getFloatingBorderChars = () =>
  config.get<string[]>('floating.border.chars')!;

export const getFloatingBorderTitle = () =>
  config.get<string>('floating.border.title')!;
