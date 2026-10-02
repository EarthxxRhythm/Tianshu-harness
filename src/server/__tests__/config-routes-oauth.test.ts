/**
 * OAuth 型 provider（codex）的设置链路契约（2026-10-02）：
 *
 *  - GET /config/providers：oauth provider 带 authType:'oauth' + oauthAuthenticated
 *    （此前 keyStatus 恒 none，桌面设置页把已登录的 codex 显示成「未配置」）。
 *  - POST /config/providers/:name/oauth/logout：清 token store + 立导入抑制标记
 *    （否则官方 CLI 登录态会把刚登出的账号当场拉回——登出永远无效）。
 *  - login 路由的负路径（非 oauth / 不存在）——正路径会真起回环监听 + 开浏览器，
 *    不进单元测试。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'
import { codexCliImportSkipPath } from '../../auth/codex-cli-auth.js'

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function oauthProvider(name: string) {
  return {
    name,
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    protocol: 'openai',
    auth: { type: 'oauth', provider: 'codex' },
    capabilities: { cacheControl: true, stripParams: [], toolJsonBug: false, prefixCache: 'none', prefixCompletion: false },
    maxTokens: 128000,
    models: [{ id: 'gpt-5.6-sol', contextWindow: 1050000, maxTokens: 128000 }],
  }
}

describe('config-routes OAuth provider（codex）', () => {
  const prevHome = process.env.RIVET_HOME
  const prevCliAuth = process.env.RIVET_CODEX_CLI_AUTH
  let home: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-oauth-routes-'))
    mkdirSync(join(home), { recursive: true })
    process.env.RIVET_HOME = home
    // 隔离官方 CLI 导入源——本机 ~/.codex/auth.json 存在时导入会让「空 store」
    // 也判已认证（serve-switch-model 的同款隔离）。
    process.env.RIVET_CODEX_CLI_AUTH = join(home, 'no-such-codex-cli-auth.json')
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: { default: 'codex', providers: { codex: oauthProvider('codex') } },
      pro: {},
    }, null, 2) + '\n')
  })
  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    if (prevCliAuth === undefined) delete process.env.RIVET_CODEX_CLI_AUTH
    else process.env.RIVET_CODEX_CLI_AUTH = prevCliAuth
    rmSync(home, { recursive: true, force: true })
  })

  it('列表：oauth provider 带 authType 与登录态（未登录=false）', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('GET', '/config/providers', {}, AUTH)
    assert.equal(res.status, 200)
    const codex = (res.body as { providers: { name: string; authType?: string; oauthAuthenticated?: boolean }[] })
      .providers.find(p => p.name === 'codex')
    assert.ok(codex, 'codex 应在列表里')
    assert.equal(codex!.authType, 'oauth', '必须标 authType=oauth——否则 UI 只能拿恒 none 的 keyStatus 猜')
    assert.equal(codex!.oauthAuthenticated, false, '空 token store = 未登录')
  })

  it('logout：清 store + 立导入抑制标记（登出不被官方 CLI 登录态拉回）', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('POST', '/config/providers/codex/oauth/logout', {}, AUTH)
    assert.equal(res.status, 200)
    assert.equal((res.body as { ok: boolean }).ok, true)
    assert.ok(existsSync(codexCliImportSkipPath(join(home, 'auth'))), '登出必须立导入抑制标记')
  })

  it('login 负路径：非 oauth provider 400，不存在的 provider 404（正路径会真起回环监听，不进单测）', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: { default: 'codex', providers: { codex: oauthProvider('codex'), plain: { name: 'plain', baseUrl: 'https://x.example.com', protocol: 'openai', models: [] } } },
      pro: {},
    }, null, 2) + '\n')
    const router = createRouter(buildConfigRoutes(TOKEN))
    const notOauth = await router('POST', '/config/providers/plain/oauth/login', {}, AUTH)
    assert.equal(notOauth.status, 400, '非 oauth provider 应 400（且在起 PKCE 之前拦截）')
    const missing = await router('POST', '/config/providers/nope/oauth/login', {}, AUTH)
    assert.equal(missing.status, 404, '不存在的 provider 应 404')
  })

  it('login/logout 路由存在性（正路径的接线契约）', () => {
    const routes = buildConfigRoutes(TOKEN)
    assert.ok('POST /config/providers/:name/oauth/login' in routes, 'login 路由必须注册')
    assert.ok('POST /config/providers/:name/oauth/logout' in routes, 'logout 路由必须注册')
  })
})
