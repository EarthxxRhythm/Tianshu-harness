/**
 * 漂移守卫：`tauri.conf.json` 的 updater 公钥 ↔ 发版文档记录的 key id。
 *
 * 为什么值得一条守卫：key id 是排障时**唯一能对着用户报错核对的凭据**
 * （`The signature verification failed` 时，第一件事是确认用户端内嵌的 pubkey
 * 与线上 manifest 的签名私钥是不是一对）。2026-09-25 一度准备把
 * `tauri.conf.json` 轮换到新 minisign 公钥（`94CFA603A032080C`），
 * `docs/DESKTOP-RELEASE.md` 也先写成了新 id；但最终决定继续使用旧 key
 * `198A2F0156FAE921`。文档与配置出现「文档新、配置旧」的漂移，而实际
 * 3.26.0 包和 `latest.json` 签名也都是旧 key。把比对变成门禁，和
 * `license-keys-drift.test.ts` 同一思路。
 *
 * 公开仓快照里没有 `desktop/`，也没有这份私有发版文档（`docs/DESKTOP-RELEASE*`
 * 不在 sync 白名单），所以文件缺失时整组跳过，不把「本仓没有」误报成漂移红。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TAURI_CONF = fileURLToPath(
  new URL('../../../desktop/src-tauri/tauri.conf.json', import.meta.url)
)
const RELEASE_DOC = fileURLToPath(new URL('../../../docs/DESKTOP-RELEASE.md', import.meta.url))

const sourcesPresent = existsSync(TAURI_CONF) && existsSync(RELEASE_DOC)
const skip = sourcesPresent
  ? false
  : '本仓无 desktop/src-tauri 或 docs/DESKTOP-RELEASE.md（公开仓快照）——漂移守卫在开发仓生效'

/**
 * 2026-09-25 一度准备轮换到、但最终没有采用的 key id。
 * 只包装成 pubkey 注释形状，用于契约自检：证明漂移断言用的是配置里
 * 实际解析出的 key id，而不是把任意 16 位十六进制字符串都放过。
 */
const OTHER_KEY_ID_FIXTURE = Buffer.from(
  'untrusted comment: minisign public key: 94CFA603A032080C\n',
).toString('base64')

/**
 * minisign pubkey 的 base64 里嵌着 `untrusted comment: minisign public key: <16 hex>`。
 * 解不出 key id 直接判失败——pubkey 形态变了就该有人来看。
 */
function updaterKeyId(pubkeyB64: string): string {
  const decoded = Buffer.from(pubkeyB64.trim(), 'base64').toString('utf8')
  const id = decoded.match(/minisign public key:\s*([0-9A-F]{16})/)?.[1]
  assert.ok(id !== undefined, `pubkey 解不出 key id（形态已变？）：${decoded.slice(0, 120)}`)
  return id
}

function currentUpdaterPubkey(): string {
  const conf = JSON.parse(readFileSync(TAURI_CONF, 'utf8')) as {
    plugins?: { updater?: { pubkey?: string } }
  }
  const pubkey = conf.plugins?.updater?.pubkey
  assert.ok(
    typeof pubkey === 'string' && pubkey.length > 0,
    'tauri.conf.json 缺少 plugins.updater.pubkey（改名/挪位请同步本守卫）'
  )
  return pubkey
}

describe('updater 公钥漂移守卫（tauri.conf.json ⇄ 发版文档）', { skip }, () => {
  it('发版文档记录的 key id 必须是 tauri.conf.json 里那把 pubkey 的', () => {
    const keyId = updaterKeyId(currentUpdaterPubkey())
    const doc = readFileSync(RELEASE_DOC, 'utf8')
    assert.ok(
      doc.includes(keyId),
      `docs/DESKTOP-RELEASE.md 里找不到当前 updater pubkey 的 key id ${keyId}——轮换公钥后必须同步该文档（含 §1.2.1 轮换清单）`
    )
  })

  it('契约自检：文档写进另一个 key id 时守卫会红', () => {
    const current = updaterKeyId(currentUpdaterPubkey())
    const other = updaterKeyId(OTHER_KEY_ID_FIXTURE)
    assert.equal(current, '198A2F0156FAE921', '当前 3.26.0 构建配置应继续使用旧 key')
    assert.notEqual(other, current, '新旧 key id 解析成了同一个——解析逻辑错了')
    const doc = readFileSync(RELEASE_DOC, 'utf8')
    assert.equal(doc.includes(current), true, '当前 key id 应在文档里')
    assert.equal(doc.includes(other), false, '未采用的 94CFA key id 不应被文档写成当前配置')
  })
})
