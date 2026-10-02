import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// L2-5 变更审阅（SCM 流）的 manifest 结构性断言（与 manifest-l2-2.test.ts 同模式）：
//  - scm/title 增两项（刷新/回滚），when 绑 scmProvider == tianshu——provider
//    注册 id（'tianshu'）经 scmProvider 上下文键链生效（fork menus.ts overlay
//    已核：['scmProvider', provider.providerId]）。
//  - 既有 git 项不动：generateCommitMessage 仍 when scmProvider == git。
//  - 两项对应命令已声明且带 icon（scm/title 菜单项渲染前提）。

interface CommandContribution {
  command: string
  title: string
  category?: string
  icon?: string
}

interface MenuItemRef {
  command?: string
  submenu?: string
  when?: string
  group?: string
}

interface ExtensionManifest {
  contributes: {
    commands?: CommandContribution[]
    menus?: Record<string, MenuItemRef[]>
  }
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as ExtensionManifest

const scmTitle = manifest.contributes.menus?.['scm/title'] ?? []

test('scm/title 挂刷新/回滚两项，绑定 scmProvider == tianshu', () => {
  const refresh = scmTitle.find((m) => m.command === 'tianshu.refreshChanges')
  assert.ok(refresh, 'refreshChanges 应挂 scm/title')
  assert.equal(refresh.when, 'scmProvider == tianshu')
  assert.equal(refresh.group, 'navigation@1')

  const rollback = scmTitle.find((m) => m.command === 'tianshu.rollback')
  assert.ok(rollback, 'rollback 应挂 scm/title')
  assert.equal(rollback.when, 'scmProvider == tianshu')
  assert.equal(rollback.group, 'navigation@2')
})

test('既有 git 项并存不回退（scm/title 共 3 项）', () => {
  const git = scmTitle.find((m) => m.command === 'tianshu.generateCommitMessage')
  assert.ok(git, 'generateCommitMessage 应保持')
  assert.equal(git.when, 'scmProvider == git')
  assert.equal(scmTitle.length, 3)
})

test('两项命令已声明且带 icon（菜单项渲染前提）', () => {
  const commands = manifest.contributes.commands ?? []
  const refresh = commands.find((c) => c.command === 'tianshu.refreshChanges')
  const rollback = commands.find((c) => c.command === 'tianshu.rollback')
  assert.ok(refresh?.icon, 'refreshChanges 应有 icon')
  assert.ok(rollback?.icon, 'rollback 应有 icon')
})
