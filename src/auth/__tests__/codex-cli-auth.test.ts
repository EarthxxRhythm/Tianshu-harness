/**
 * codex-cli-auth：官方 Codex CLI 登录态（~/.codex/auth.json）→ 我们 token store
 * 的一次性导入。
 *
 * 背景（2026-10-02 用户实报）：本机已用官方 Codex CLI 登录 ChatGPT
 * （~/.codex/auth.json 齐全），桌面端却用不了 codex——我们的 OAuth store
 * （~/.rivet/auth/codex.json）为空，而代码从不读官方 CLI 的登录态。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodexCliToken, codexCliAuthPath } from '../codex-cli-auth.js'
import { OAuthAuth } from '../oauth-auth.js'

let dir: string
let authJson: string
let prevEnv: string | undefined

function fakeJwt(exp: number): string {
  const b64u = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ exp, sub: 'user-1' })}.sig`
}

function writeAuthJson(body: unknown): void {
  writeFileSync(authJson, typeof body === 'string' ? body : JSON.stringify(body))
}

const EXP = Math.floor(Date.now() / 1000) + 3600

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-cli-auth-'))
  authJson = join(dir, 'auth.json')
  prevEnv = process.env.RIVET_CODEX_CLI_AUTH
  process.env.RIVET_CODEX_CLI_AUTH = authJson
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.RIVET_CODEX_CLI_AUTH
  else process.env.RIVET_CODEX_CLI_AUTH = prevEnv
  rmSync(dir, { recursive: true, force: true })
})

test('路径：env 覆盖优先，缺省落 ~/.codex/auth.json', () => {
  assert.equal(codexCliAuthPath({ RIVET_CODEX_CLI_AUTH: '/x/y.json' }), '/x/y.json')
  assert.ok(codexCliAuthPath({}).endsWith(join('.codex', 'auth.json')))
})

test('有效 auth.json → TokenData 齐全（exp 从 JWT 解出，refresh/account_id 带上）', () => {
  writeAuthJson({
    auth_mode: 'chatgpt',
    tokens: { id_token: 'x', access_token: fakeJwt(EXP), refresh_token: 'rt-1', account_id: 'acc-1' },
  })
  const t = readCodexCliToken()
  assert.ok(t, '应读到 token')
  assert.equal(t!.refreshToken, 'rt-1')
  assert.equal(t!.accountId, 'acc-1')
  assert.equal(t!.expiresAt, EXP * 1000)
  assert.ok(t!.accessToken.split('.').length === 3)
})

test('不合形一律 null：文件缺失 / 坏 JSON / 缺 access_token / 非 JWT / 解不出 exp', () => {
  assert.equal(readCodexCliToken({ RIVET_CODEX_CLI_AUTH: join(dir, 'nope.json') }), null, '文件不存在')
  writeAuthJson('not-json{{{')
  assert.equal(readCodexCliToken(), null, '坏 JSON')
  writeAuthJson({ auth_mode: 'chatgpt', tokens: {} })
  assert.equal(readCodexCliToken(), null, '缺 access_token')
  writeAuthJson({ tokens: { access_token: 'opaque-string' } })
  assert.equal(readCodexCliToken(), null, '非 JWT')
  const noExp = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"sub":"u"}').toString('base64url')}.sig`
  writeAuthJson({ tokens: { access_token: noExp } })
  assert.equal(readCodexCliToken(), null, 'JWT 无 exp')
})

test('OAuthAuth：store 为空时自动从官方 CLI 导入——免 PKCE', () => {
  writeAuthJson({ tokens: { access_token: fakeJwt(EXP), refresh_token: 'rt-1', account_id: 'acc-1' } })
  const auth = new OAuthAuth({ clientId: 'x', tokenEndpoint: 'https://x/token', importCliAuth: authJson }, join(dir, 'store'))
  try {
    assert.equal(auth.isAuthenticated(), true, '应导入官方 CLI 登录态')
    // 落我们自己的（加密）store——文件存在且不是明文 JSON
    const storeFile = join(dir, 'store', 'codex.json')
    assert.ok(existsSync(storeFile), '导入后应落盘 codex.json')
    const raw = readFileSync(storeFile, 'utf8')
    assert.ok(raw.includes('aes-256-gcm'), '落盘应为加密信封')
    assert.ok(!raw.includes('rt-1'), '密文里看不到 refresh token 明文')
    // 一次性语义：删掉源文件后依然已认证（读的是我们自己的 store，不再依赖源）
    rmSync(authJson)
    assert.equal(auth.isAuthenticated(), true, '导入一次后不再依赖源文件')
  } finally {
    auth.dispose()
  }
})

test('OAuthAuth：没有导入源时仍是未认证（基线不被导入逻辑破坏）', () => {
  const auth = new OAuthAuth({ clientId: 'x', tokenEndpoint: 'https://x/token', importCliAuth: false }, join(dir, 'store'))
  try {
    assert.equal(auth.isAuthenticated(), false)
  } finally {
    auth.dispose()
  }
})
