'use strict'
import { attach, Attach, NeovimClient } from '@chemzqm/neovim'
import { URI } from 'vscode-uri'
import events from './events'
import { createLogger } from './logger'
import Plugin from './plugin'
import { VERSION } from './util/constants'
import './util/extensions'
import { objectLiteral } from './util/is'
import { semver } from './util/node'
import { createTiming } from './util/timing'
const logger = createLogger('attach')

/**
 * Request actions that not need plugin ready
 */
const ACTIONS_NO_WAIT = ['installExtensions', 'updateExtensions']
const semVer = semver.parse(VERSION)
const pendingNotifications: Map<string, any[]> = new Map()

export function pathReplace(patterns: object | undefined): void {
  if (objectLiteral(patterns)) {
    const old_uri = URI.file
    URI.file = (path): URI => {
      path = path.replace(/\\/g, '/')
      Object.keys(patterns).forEach(k => path = path.replace(new RegExp('^' + k), patterns[k]))
      return old_uri(path)
    }
  }
}

export function toText(error: any): string {
  return error instanceof Error ? error.message : error.toString()
}

export default (opts: Attach, requestApi = true): Plugin => {
  const nvim: NeovimClient = attach(opts, createLogger('node-client'), requestApi)
  nvim.setVar('coc_process_pid', process.pid, true)
  nvim.setClientInfo('coc', { major: semVer.major, minor: semVer.minor, patch: semVer.patch }, 'remote', {}, {})
  const plugin = new Plugin(nvim)
  let disposable = events.on('ready', () => {
    disposable.dispose()
    for (let [method, args] of pendingNotifications.entries()) {
      plugin.cocAction(method, ...args).catch(e => {
        console.error(`Error on notification "${method}": ${e}`)
        logger.error(`Error on notification ${method}`, e)
      })
    }
    pendingNotifications.clear()
  })

  nvim.on('notification', async (method, args) => {
    switch (method) {
      case 'VimEnter': {
        pathReplace(args[0])
        await plugin.init(args[1])
        break
      }
      case 'Log': {
        logger.debug('Vim log', ...args)
        break
      }
      case 'TaskExit':
      case 'TaskStderr':
      case 'TaskStdout':
      case 'GlobalChange':
      case 'PromptInsert':
      case 'InputChar':
      case 'MenuInput':
      case 'OptionSet':
      case 'PromptKeyPress':
      case 'FloatBtnClick':
      case 'CompleteStop':
        logger.trace('Event: ', method, ...args)
        await events.fire(method, args)
        break
      case 'CocAutocmd':
        logger.trace('Notification autocmd:', ...args)
        await events.fire(args[0], args.slice(1))
        break
      case 'redraw':
        break
      default: {
        try {
          logger.info('receive notification:', method, args)
          if (!plugin.isReady) {
            pendingNotifications.set(method, args)
            return
          }
          await plugin.cocAction(method, ...args)
        } catch (e) {
          console.error(`Error on notification "${method}": ${toText(e)}`)
          logger.error(`Error on notification ${method}`, e)
        }
      }
    }
  })

  let timing = createTiming('Request', 3000)
  nvim.on('request', async (method: string, args, resp) => {
    timing.start(method)
    try {
      events.requesting = true
      if (method == 'CocAutocmd') {
        logger.trace('Request autocmd:', ...args)
        await events.fire(args[0], args.slice(1))
        resp.send(undefined)
      } else {
        if (!plugin.isReady && !ACTIONS_NO_WAIT.includes(method)) {
          logger.warn(`Plugin not ready on request "${method}"`, args)
          resp.send('Plugin not ready', true)
        } else {
          logger.info('Request action:', method, args)
          let res = await plugin.cocAction(method, ...args)
          resp.send(res)
        }
      }
      events.requesting = false
    } catch (e) {
      events.requesting = false
      resp.send(toText(e), true)
      logger.error(`Request error:`, method, args, e)
    }
    timing.stop()
  })
  return plugin
}
