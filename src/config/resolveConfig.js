import assert from 'assert'
import { pathToFileURL } from 'url'
import { mkdirSync, writeFileSync } from '../fs.js'
import { glob } from '../glob/glob.js'
import { logger } from '../logger/logger.js'
import { dirname, isAbsolute, join } from '../path.js'
import { isTest } from '../utils/isTest.js'
import { validateConfig } from './validateConfig.js'

/**
 * @typedef {import('../../index.js').LazyConfig} LazyConfig
 */

/**
 * @typedef {unknown} LoadedConfig
 */

/**
 * @typedef {{config: LazyConfig, filePath: null | string}} ResolvedConfig
 */

/**
 * @returns {Promise<ResolvedConfig>}
 * @param {string} dir
 */
export async function resolveConfig(dir) {
  const files = glob.sync(['lazy.config.{js,cjs,mjs,ts,cts,mts}'], {
    cwd: dir,
  })

  if (files.length > 1) {
    throw logger.fail(`Found multiple lazy config files in dir '${dir}'.`, {
      detail: `Remove all but one of the following files: ${files.join(', ')}`,
    })
  }

  if (files.length === 0) {
    return { filePath: null, config: {} }
  } else {
    const file = files[0]
    const loadedConfig = await loadConfig(file)

    try {
      const config = validateConfig(loadedConfig)

      return { filePath: file, config }
    } catch (err) {
      throw logger.fail(`Failed reading config file at '${file}'`, {
        detail: err instanceof Error ? err.message : undefined,
      })
    }
  }
}

/**
 * @param {string} file
 * @returns {Promise<LoadedConfig>}
 */
async function loadConfig(file) {
  assert(isAbsolute(file))
  if (file.endsWith('.js') || file.endsWith('.cjs') || file.endsWith('.mjs')) {
    // windows prefers a file:/// url here
    const url = pathToFileURL(file).toString()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return (await import(url)).default
  }

  const configDir = join(dirname(file), '.lazy')

  mkdirSync(configDir, { recursive: true })

  const inFile = join(configDir, 'config.source.mjs')
  writeFileSync(inFile, `import config from '${file}'; export default config`)
  const outFile = join(configDir, 'config.cache.mjs')

  const esbuild = await import('esbuild')
  await esbuild.build({
    entryPoints: [inFile],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    packages: 'external',
    sourcemap: 'inline',
    sourcesContent: true,
    format: 'esm',
  })

  if (!isTest) {
    // @ts-expect-error
    await import('source-map-support/register.js')
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
  return (await import(pathToFileURL(outFile).toString())).default
}
