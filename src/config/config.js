import slugify from '@sindresorhus/slugify'
import path, { isAbsolute, relative } from 'path'
import pc from 'picocolors'
import { logger } from '../logger/logger.js'
import { Project } from '../project/Project.js'
import { resolveConfig } from './resolveConfig.js'

export class RunsAfterConfig {
  /**
   * @private
   * @type {import('./config-types.js').RunsAfter}
   */
  _runsAfter

  constructor(/** @type {import('./config-types.js').RunsAfter} */ runsAfter) {
    this._runsAfter = runsAfter
  }

  get usesOutput() {
    return this._runsAfter.usesOutput ?? true
  }

  get inheritsInput() {
    return this._runsAfter.inheritsInput ?? false
  }

  get in() {
    return this._runsAfter.in ?? 'all-packages'
  }
}

export class TaskConfig {
  /** @private  */
  _config
  /**
   * @param {import('../project/project-types.js').Workspace} workspace
   * @param {string} name
   * @param {Config} config
   */
  constructor(workspace, name, config) {
    this.workspace = workspace
    this.name = name
    this._config = config
  }

  getManifestPath() {
    const dir = path.join(this.workspace.dir, '.lazy', 'manifests')
    return path.join(dir, slugify(this.name))
  }

  getNextManifestPath() {
    const dir = path.join(this.workspace.dir, '.lazy', 'manifests')
    return path.join(dir, slugify(this.name) + '.next')
  }

  getDiffPath() {
    const dir = path.join(this.workspace.dir, '.lazy', 'diffs')
    return path.join(dir, slugify(this.name))
  }

  /** @private */
  get scriptConfig() {
    return this._config.rootConfig.config.scripts?.[this.name] ?? {}
  }

  get execution() {
    return this.scriptConfig.execution ?? 'dependent'
  }

  get baseCommand() {
    return this.scriptConfig.baseCommand
  }

  /** @type {[string, RunsAfterConfig][]} */
  get runsAfterEntries() {
    return Object.entries(this.scriptConfig.runsAfter ?? {}).map(([name, config]) => {
      return [name, new RunsAfterConfig(config)]
    })
  }

  get parallel() {
    return this.scriptConfig.parallel ?? true
  }

  get cache() {
    const cache = this.scriptConfig.cache
    if (cache === 'none') {
      return cache
    } else {
      return {
        envInputs: cache?.envInputs ?? [],
        inheritsInputFromDependencies: cache?.inheritsInputFromDependencies ?? true,
        inputs: extractGlobPattern(cache?.inputs),
        outputs: extractGlobPattern(cache?.outputs),
        usesOutputFromDependencies: cache?.usesOutputFromDependencies ?? true,
      }
    }
  }

  get command() {
    const baseCommand = this.baseCommand
    const script = this.workspace.scripts[this.name]
    let command = this.execution === 'top-level' ? baseCommand : script

    if (!command) {
      logger.fail(`No command found for script ${this.name} in ${this.workspace.dir}/package.json`)
      process.exit(1)
    }

    if (this.execution !== 'top-level') {
      const inheritMatch = extractInheritMatch(command)

      if (inheritMatch) {
        if (!baseCommand) {
          // TODO: evaluate this stuff ahead-of-time
          logger.fail(
            `Encountered 'lazy inherit' for scripts#${this.name} in ${this.workspace.dir}/package.json, but there is no baseCommand configured for the task '${this.name}'`,
          )
          process.exit(1)
        } else {
          command = `${inheritMatch.envVars ?? ''} ${baseCommand} ${inheritMatch.extraArgs ?? ''}`
          command = command.trim()
        }
      }
    }

    command = command.replaceAll('<rootDir>', this._config.project.root.dir)

    return command
  }
}

/**
 * TODO: can we use @yarnpkg/shell parser here?
 * @param {string} command
 */
export function extractInheritMatch(command) {
  const match = command.match(/^(\w+=\S* )*(yarn run( -T| --top-level)? )?lazy inherit($| .*$)/)
  if (!match) return null

  const [, envVars, , , extraArgs] = match

  return { envVars: envVars?.trim() || null, extraArgs: extraArgs?.trim() || null }
}

/**
 *
 * @param {import('./config-types.js').GlobConfig | null | undefined} glob
 * @returns {{include: string[], exclude: string[]}}
 */
function extractGlobPattern(glob) {
  if (!glob) {
    return {
      include: ['**/*'],
      exclude: [],
    }
  }
  if (Array.isArray(glob)) {
    return {
      include: glob,
      exclude: [],
    }
  }

  return { include: glob.include ?? ['**/*'], exclude: glob.exclude ?? [] }
}

export class Config {
  /** @readonly */ rootConfig
  /** @readonly */ project

  /**
   * @typedef {Object} ConfigWrapperOptions
   *
   * @property {Project} project
   * @property {import('./resolveConfig.js').ResolvedConfig} rootConfig
   */
  /** @param {ConfigWrapperOptions} options */
  constructor({ project, rootConfig }) {
    this.project = project
    this.rootConfig = rootConfig
  }

  /**
   * @param {string} cwd
   */
  static async fromCwd(cwd) {
    let project = Project.fromCwd(cwd)
    const rootConfig = await resolveConfig(project.root.dir)
    project = project.withoutIgnoredWorkspaces(rootConfig.config.ignoreWorkspaces ?? [])

    if (!rootConfig.filePath) {
      logger.log('No config files found, using default configuration.\n')
    } else {
      logger.log(pc.gray(`Loaded config file: ${relative(process.cwd(), rootConfig.filePath)}\n`))
    }

    return new Config({
      project,
      rootConfig,
    })
  }
  /**
   * @param {import('../project/project-types.js').Workspace} workspace
   * @param {string} scriptName
   * @returns {TaskConfig}
   */
  getTaskConfig(workspace, scriptName) {
    return new TaskConfig(workspace, scriptName, this)
  }

  /**
   * @param {string} scriptName
   */
  isTopLevelScript(scriptName) {
    return this.rootConfig.config.scripts?.[scriptName]?.execution === 'top-level'
  }

  /**
   * @param {string} taskDir
   * @param {string} scriptName
   */
  getTaskKey(taskDir, scriptName) {
    if (!isAbsolute(taskDir)) throw new Error(`taskKey: taskDir must be absolute: ${taskDir}`)
    return `${scriptName}::${relative(this.project.root.dir, taskDir) || '<rootDir>'}`
  }

  /**
   * @returns {{include: string[], exclude: string[], envInputs: string[]}}
   */
  getBaseCacheConfig() {
    const config = this.rootConfig.config.baseCacheConfig

    const include = config?.include ?? [
      '<rootDir>/{yarn.lock,pnpm-lock.yaml,package-lock.json}',
      '<rootDir>/lazy.config.*',
    ]
    const exclude = config?.exclude ?? []
    return {
      include,
      exclude,
      envInputs: config?.envInputs ?? [],
    }
  }
}
