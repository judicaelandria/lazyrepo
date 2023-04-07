import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import kleur from 'kleur'
import { getDiffPath, getManifestPath } from './config.js'
import { log } from './log.js'

import path from 'path'
import stripAnsi from 'strip-ansi'
import { compareManifests, renderChange } from './manifest/compareManifests.js'
import { writeManifest } from './manifest/writeManifest.js'

/**
 * @param {import('./types.js').ScheduledTask} task
 * @param {import('./TaskGraph.js').TaskGraph} tasks
 * @returns {Promise<boolean>}
 */
export async function runTaskIfNeeded(task, tasks) {
  const currentManifestPath = getManifestPath(task)
  const previousManifestPath = currentManifestPath + '.prev'

  /**
   * @param  {string} msg
   */
  const print = (msg) => console.log(task.terminalPrefix, msg)

  const didHaveManifest = existsSync(currentManifestPath)

  /**
   * @type {Record<string, [hash: string, lastModified: number]> | undefined}
   */
  let prevManifest

  if (didHaveManifest) {
    renameSync(currentManifestPath, previousManifestPath)
    const prevManifestString = readFileSync(previousManifestPath, 'utf-8').toString()
    prevManifest = {}
    for (const line of prevManifestString.split('\n')) {
      const [thing, hash, lastModified] = line.split('\t')
      if (thing.startsWith('file ')) {
        const filePath = thing.slice('file '.length)
        prevManifest[filePath] = [hash, Number(lastModified)]
      }
    }
  }

  await writeManifest({ task, tasks, prevManifest })

  let didRunTask = false

  if (didHaveManifest) {
    const diff = compareManifests(
      readFileSync(previousManifestPath).toString(),
      readFileSync(currentManifestPath).toString(),
    )

    if (diff.length) {
      const allLines = diff.map(renderChange)
      const diffPath = getDiffPath(task)
      if (!existsSync(path.dirname(diffPath))) {
        mkdirSync(path.dirname(diffPath), { recursive: true })
      }
      writeFileSync(diffPath, stripAnsi(allLines.join('\n')))
      print('cache miss, changes since last run:')
      allLines.slice(0, 10).forEach((line) => print(kleur.gray(line)))
      if (allLines.length > 10) {
        print(kleur.gray(`... and ${allLines.length - 10} more. See ${diffPath} for full diff.`))
      }

      await runTask(task)
      didRunTask = true
    }
  } else {
    await runTask(task)
    didRunTask = true
  }

  print(kleur.gray('input manifest saved: ' + path.relative(process.cwd(), currentManifestPath)))

  if (!didRunTask) {
    print(`cache hit ⚡️`)
  }

  return didRunTask
}

/**
 * @param {import('./types.js').ScheduledTask} task
 * @returns {Promise<void>}
 */
async function runTask(task) {
  const packageJson = JSON.parse(readFileSync(`${task.cwd}/package.json`, 'utf8'))
  const command = packageJson.scripts[task.taskName]

  const extraArgs = process.argv.slice(3)
  const start = Date.now()

  console.log(task.terminalPrefix + kleur.bold(' RUN ') + kleur.green().bold(command))
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('/usr/bin/env', ['sh', '-c', command + ' ' + extraArgs.join(' ')], {
        cwd: task.cwd,
        env: {
          ...process.env,
          PATH: `${process.env.PATH}:./node_modules/.bin:${process.cwd()}/node_modules/.bin`,
          FORCE_COLOR: '1',
        },
      })
      // forward all output to the terminal without losing color
      let outData = ''

      // save stdout to buffer

      proc.stdout.on('data', (data) => {
        console.log('stdout')
        outData += data
        const lastLineFeed = outData.lastIndexOf('\n')
        if (lastLineFeed === -1) {
          return
        }

        const lines = outData.replaceAll('\r', '').split('\n')
        outData = lines.pop() || ''

        for (const line of lines) {
          process.stdout.write(task.terminalPrefix + ' ' + line + '\n')
        }
      })

      let errData = ''

      proc.stderr.on('data', (data) => {
        errData += data
        const lastLineFeed = errData.lastIndexOf('\n')
        if (lastLineFeed === -1) {
          return
        }

        const lines = errData.replaceAll('\r', '').split('\n')
        errData = lines.pop() || ''

        for (const line of lines) {
          process.stderr.write(task.terminalPrefix + ' ' + line + '\n')
        }
      })

      proc.on('exit', (code) => {
        if (outData) {
          process.stdout.write(task.terminalPrefix + ' ' + outData + '\n')
        }
        if (errData) {
          process.stderr.write(task.terminalPrefix + ' ' + errData + '\n')
        }
        if (code === 0) {
          resolve(null)
        } else {
          reject(new Error(`Command '${command}' exited with code ${code}`))
        }
      })

      proc.on('error', (err) => {
        reject(err)
      })
    })
  } catch (e) {
    const manifestPath = getManifestPath(task)
    if (existsSync(manifestPath)) {
      unlinkSync(manifestPath)
    }
    throw e
  }

  log.log(
    task.terminalPrefix,
    `done in ${kleur.cyan(((Date.now() - start) / 1000).toFixed(2) + 's')}`,
  )
}