import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ReadStream, WriteStream } from 'node:tty'
import type { BootstrapContext } from '../../../bootstrap.js'
import { SessionContext } from '../../../agent/context.js'
import { createFrontendMetricsProvider } from '../../frontend-session-provider.js'
import { DEFAULT_FRONTEND_PREFERENCES } from '../../frontend-preferences.js'
import { TuiApp } from '../app.js'
import { MockIn, MockOut, stripAnsi } from './_harness.js'

test('frontend metrics provider carries the session CVM count into the new workspace chrome', () => {
  const session = new SessionContext()
  const runtime = {
    session,
    agent: {
      config: { providerName: 'deepseek', allProviders: {}, contextWindow: 200_000, promptEngine: { getModel: () => 'deepseek-chat' } },
      cvmVector: { mode: 'active' },
    },
  }
  const out = new MockOut()
  const app = new TuiApp({ stdin: new MockIn() as unknown as ReadStream, stdout: out as unknown as WriteStream, cols: 120, rows: 24 })
  app.setFrontendPreferences({ ...DEFAULT_FRONTEND_PREFERENCES, renderer: 'classic' })
  app.start()
  app.setMetricsProvider(createFrontendMetricsProvider(app, () => runtime as unknown as BootstrapContext))
  try {
    session.recordCvmInterception('gate-blocked')
    out.chunks.length = 0
    app.forceRedraw()
    assert.equal(app.getMetrics()?.cvmInterceptions, 1)
    assert.ok(stripAnsi(out.chunks.join('')).includes('⛨ 1'), 'the actual provider must reach the rendered badge')
    assert.ok(app.getMetrics()?.pricingPhase, 'DeepSeek pricing remains available through the extracted provider')
    runtime.agent.cvmVector.mode = 'off'
    out.chunks.length = 0
    app.forceRedraw()
    assert.equal(app.getMetrics()?.cvmInterceptions, undefined)
    assert.ok(!stripAnsi(out.chunks.join('')).includes('⛨'), 'disabled CVM must not be presented as zero interceptions')
  } finally { app.dispose() }
})
