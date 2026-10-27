import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { commandDeveloperDir } from './host.ts';
import {
  readSdkVersion,
  readXcodeVersion,
  resolveSelectedDeveloperDir,
  ToolchainFileError,
  type AppleSdkName,
} from './xcode-bundle-identity.ts';

const TOOLCHAIN_FILE_HINT =
  'The Apple runner cache is keyed on the toolchain version, so a cache decision cannot be made without it. Check that `xcode-select -p` or DEVELOPER_DIR names a full Xcode install.';

/** Toolchain half of the runner cache key. Every field is read from the selected Xcode. */
export type RunnerToolchainFingerprint = {
  xcodeVersion: string;
  xcodeBuildVersion: string;
  sdkName: AppleSdkName;
  sdkVersion: string;
  sdkBuildVersion: string;
};

/**
 * The toolchain half of the cache key. It also names the derived-data directory, so an
 * unreadable toolchain fails the cache decision instead of standing in for one. The read
 * blocks on nothing, so an aborted owner is answered before it rather than during it.
 */
export function requireRunnerToolchainFingerprint(
  sdkName: AppleSdkName,
  signal: AbortSignal | undefined,
): RunnerToolchainFingerprint {
  if (signal?.aborted) throw createRequestCanceledError({ phase: 'apple_toolchain_identity' });
  const chosenDir = commandDeveloperDir();
  try {
    const developerDir = resolveSelectedDeveloperDir(chosenDir);
    const xcode = readXcodeVersion(developerDir);
    const sdk = readSdkVersion(developerDir, sdkName);
    return {
      xcodeVersion: xcode.version,
      xcodeBuildVersion: xcode.buildVersion,
      sdkName,
      sdkVersion: sdk.version,
      sdkBuildVersion: sdk.buildVersion,
    };
  } catch (error) {
    if (!(error instanceof ToolchainFileError)) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      `Could not read the Xcode toolchain versions the Apple runner cache is keyed on (${error.message})`,
      {
        reason: 'apple_toolchain_unreadable',
        ...(chosenDir === undefined ? {} : { developerDir: chosenDir }),
        file: error.file,
        detail: error.detail,
        hint: TOOLCHAIN_FILE_HINT,
      },
    );
  }
}

/** The selected Xcode's version, for a failure report that names it; undefined when unreadable. */
export function readRunnerXcodeVersion(): string | undefined {
  try {
    return readXcodeVersion(resolveSelectedDeveloperDir(commandDeveloperDir())).version;
  } catch (error) {
    if (error instanceof ToolchainFileError) return undefined;
    throw error;
  }
}
