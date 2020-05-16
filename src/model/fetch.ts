import { http, https } from 'follow-redirects'
import { Readable } from 'stream'
import { parse, UrlWithStringQuery } from 'url'
import zlib from 'zlib'
import { objectLiteral } from '../util/is'
import workspace from '../workspace'
import { FetchOptions } from '../types'
import createHttpProxyAgent, { HttpProxyAgent } from 'http-proxy-agent'
import createHttpsProxyAgent, { HttpsProxyAgent } from 'https-proxy-agent'
const logger = require('../util/logger')('model-fetch')

export type ResponseResult = string | Buffer | { [name: string]: any }

export interface ProxyOptions {
  proxyUrl: string
  strictSSL?: boolean
}

function getSystemProxyURI(endpoint: UrlWithStringQuery): string {
  let env: string | null
  if (endpoint.protocol === 'http:') {
    env = process.env.HTTP_PROXY || process.env.http_proxy || null
  } else if (endpoint.protocol === 'https:') {
    env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null
  }
  let noProxy = process.env.NO_PROXY || process.env.no_proxy
  if (noProxy === '*') {
    env = null
  } else if (noProxy) {
    // canonicalize the hostname, so that 'oogle.com' won't match 'google.com'
    const hostname = endpoint.hostname.replace(/^\.*/, '.').toLowerCase()
    const port = endpoint.port || endpoint.protocol.startsWith('https') ? '443' : '80'
    const noProxyList = noProxy.split(',')
    for (let i = 0, len = noProxyList.length; i < len; i++) {
      let noProxyItem = noProxyList[i].trim().toLowerCase()
      // no_proxy can be granular at the port level, which complicates things a bit.
      if (noProxyItem.includes(':')) {
        let noProxyItemParts = noProxyItem.split(':', 2)
        let noProxyHost = noProxyItemParts[0].replace(/^\.*/, '.')
        let noProxyPort = noProxyItemParts[1]
        if (port === noProxyPort && hostname.endsWith(noProxyHost)) {
          env = null
          break
        }
      } else {
        noProxyItem = noProxyItem.replace(/^\.*/, '.')
        if (hostname.endsWith(noProxyItem)) {
          env = null
          break
        }
      }
    }
  }
  return env
}

export function getAgent(endpoint: UrlWithStringQuery, options: ProxyOptions): HttpsProxyAgent | HttpProxyAgent {
  let proxy = options.proxyUrl || getSystemProxyURI(endpoint)
  if (proxy) {
    const proxyEndpoint = parse(proxy)
    if (!/^https?:$/.test(proxyEndpoint.protocol)) {
      return null
    }
    let opts = {
      host: proxyEndpoint.hostname,
      port: Number(proxyEndpoint.port),
      auth: proxyEndpoint.auth,
      rejectUnauthorized: typeof options.strictSSL === 'boolean' ? options.strictSSL : true
    }
    logger.info(`Using proxy from ${options.proxyUrl ? 'configuration' : 'system environment'} for ${endpoint.hostname}:`, opts)
    return endpoint.protocol === 'http:' ? createHttpProxyAgent(opts) : createHttpsProxyAgent(opts)
  }
  return null
}

export function resolveRequestOptions(url: string, options: FetchOptions = {}): any {
  let config = workspace.getConfiguration('http')
  let proxyOptions: ProxyOptions = {
    proxyUrl: config.get<string>('proxy', ''),
    strictSSL: config.get<boolean>('proxyStrictSSL', true)
  }
  let endpoint = parse(url)
  let agent = getAgent(endpoint, proxyOptions)
  let opts: any = {
    method: options.method || 'GET',
    hostname: endpoint.hostname,
    port: endpoint.port ? parseInt(endpoint.port, 10) : (endpoint.protocol === 'https:' ? 443 : 80),
    path: endpoint.path,
    agent,
    rejectUnauthorized: proxyOptions.strictSSL,
    headers: Object.assign({
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
      'Accept-Encoding': 'gzip, deflate'
    }, options.headers || {})
  }
  if (options.user && options.password) {
    opts.auth = options.user + ':' + options.password
  }
  if (options.timeout) {
    opts.timeout = options.timeout
  }
  return opts
}

function request(url: string, data: string | Buffer | { [key: string]: any }, opts: any): Promise<ResponseResult> {
  let mod = url.startsWith('https:') ? https : http
  return new Promise<ResponseResult>((resolve, reject) => {
    const req = mod.request(opts, res => {
      let readable: Readable = res
      if ((res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 1223) {
        let headers = res.headers || {}
        let chunks: Buffer[] = []
        let contentType = headers['content-type'] || ''
        let contentEncoding = headers['content-encoding'] || ''
        if (contentEncoding === 'gzip') {
          const unzip = zlib.createGunzip()
          readable = res.pipe(unzip)
        } else if (contentEncoding === 'deflate') {
          let inflate = zlib.createInflate()
          res.pipe(inflate)
          readable = inflate
        }
        readable.on('data', chunk => {
          chunks.push(chunk)
        })
        readable.on('end', () => {
          let buf = Buffer.concat(chunks)
          if (contentType.includes('application/octet-stream')
            || contentType.includes('application/zip')) {
            resolve(buf)
          } else {
            let ms = contentType.match(/charset=(\S+)/)
            let encoding = ms ? ms[1] : 'utf8'
            let rawData = buf.toString(encoding)
            if (!contentType.includes('application/json')) {
              resolve(rawData)
            } else {
              try {
                const parsedData = JSON.parse(rawData)
                resolve(parsedData)
              } catch (e) {
                reject(new Error(`Parse response error: ${e}`))
              }
            }
          }
        })
        readable.on('error', err => {
          reject(new Error(`Unable to connect ${url}: ${err.message}`))
        })
      } else {
        reject(new Error(`Bad response from ${url}: ${res.statusCode}`))
      }
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error(`request timeout after ${opts.timeout}ms`))
    })
    if (data) {
      if (typeof data == 'string' || Buffer.isBuffer(data)) {
        req.write(data)
      } else {
        req.write(JSON.stringify(data))
      }
    }
    if (opts.timeout) {
      req.setTimeout(opts.timeout)
    }
    req.end()
  })
}

/**
 * Fetch text from server
 */
export default function fetch(
  url: string,
  data?: string | Buffer | { [key: string]: any },
  options: FetchOptions = {}): Promise<ResponseResult> {
  let opts = resolveRequestOptions(url, options)
  if (data && !Buffer.isBuffer(data) && objectLiteral(data)) {
    opts.headers['Content-Type'] = 'application/json'
  }
  return request(url, data, opts).catch(err => {
    if (opts.agent && opts.agent.proxy) {
      let { proxy } = opts.agent
      throw new Error(`Error on fetch using proxy ${proxy.host}: ${err.message}`)
    } else {
      throw err
    }
  })
}