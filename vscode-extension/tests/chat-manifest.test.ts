import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// chat 接入的 manifest 前置条件：participant id / 默认位 / proposals 声明 / BYOK 声明。
// 缺任何一项——不带 @ 的输入不会路由到天枢（贡献点对缺声明的 participant 整条丢弃），
// 或 chat 视图继续显示 Copilot setup 死路（没有注册模型时 VS Code 不路由任何请求）。

interface ChatParticipantContribution {
  id: string
  name: string
  isDefault?: boolean
  modes?: string[]
  locations?: string[]
}

interface ExtensionManifest {
  enabledApiProposals?: string[]
  activationEvents?: string[]
  contributes: {
    chatParticipants?: ChatParticipantContribution[]
    languageModelChatProviders?: { vendor: string; displayName: string }[]
  }
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as ExtensionManifest

test('声明唯一 participant：id/name 与注册代码一致', () => {
  assert.equal(manifest.contributes.chatParticipants?.length, 1)
  const [p] = manifest.contributes.chatParticipants ?? []
  assert.equal(p?.id, 'tianshu.default')
  assert.equal(p?.name, 'tianshu')
})

test('默认位：panel 的 ask/agent 模式都不带 @ 路由到天枢', () => {
  const [p] = manifest.contributes.chatParticipants ?? []
  assert.equal(p?.isDefault, true)
  assert.deepEqual(p?.modes, ['ask', 'agent'])
  assert.deepEqual(p?.locations, ['panel'])
})

test('proposals 声明齐全（贡献点对这些字段整条校验）', () => {
  assert.ok(manifest.enabledApiProposals?.includes('defaultChatParticipant'))
  assert.ok(manifest.enabledApiProposals?.includes('chatParticipantAdditions'))
  assert.ok(manifest.enabledApiProposals?.includes('chatParticipantPrivate'))
})

test('BYOK model provider 声明：vendor=tianshu（chat-gate fallback 按它取模型）', () => {
  assert.equal(manifest.contributes.languageModelChatProviders?.length, 1)
  const [m] = manifest.contributes.languageModelChatProviders ?? []
  assert.equal(m?.vendor, 'tianshu')
})

test('激活事件自带 chat 触发（懒激活设计不被破坏）', () => {
  assert.ok(manifest.activationEvents?.includes('onChatParticipant:tianshu.default'))
  assert.ok(manifest.activationEvents?.includes('onLanguageModelChatProvider:tianshu'))
})
