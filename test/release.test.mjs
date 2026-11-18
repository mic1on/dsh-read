import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { publishRelease } from '../scripts/release.mjs'

function fixture({ release = null, reference = null, annotated = null, fail = {} } = {}) {
  const calls = []
  const methods = {
    getReleaseByTag: release,
    getRef: reference,
    getTag: annotated,
    createRef: {},
    createRelease: { html_url: 'https://github.com/example/reader/releases/tag/v0.3.0' },
  }
  const api = Object.fromEntries(Object.entries(methods).map(([method, data]) => [method, async (params) => {
    calls.push({ method, params })
    if (fail[method]) throw fail[method]
    if (data === null) throw Object.assign(new Error('Not Found'), { status: 404 })
    return { data }
  }]))
  const input = {
    github: { rest: { repos: api, git: api } },
    context: { eventName: 'push', ref: 'refs/heads/main', sha: 'tested-sha', repo: { owner: 'example', repo: 'reader' } },
    core: { info() {} },
    version: '0.3.0',
  }
  return { calls, input }
}

test('creates a tag at the tested commit and a release with generated notes', async () => {
  const { input, calls } = fixture()
  await publishRelease(input)
  assert.deepEqual(calls.map(({ method }) => method), ['getReleaseByTag', 'getRef', 'createRef', 'createRelease'])
  assert.deepEqual(calls[2].params, { owner: 'example', repo: 'reader', ref: 'refs/tags/v0.3.0', sha: 'tested-sha' })
  assert.deepEqual(calls[3].params, {
    owner: 'example', repo: 'reader', tag_name: 'v0.3.0', target_commitish: 'tested-sha',
    name: 'v0.3.0', generate_release_notes: true, draft: false, prerelease: false, make_latest: 'legacy',
  })
})

test('skips published versions even when a later push has the same version', async () => {
  const { input, calls } = fixture({ release: { draft: false } })
  input.context.sha = 'later-sha'
  await publishRelease(input)
  assert.equal(calls.length, 1)
})

test('does not publish or replace a pre-existing draft', async () => {
  const { input, calls } = fixture({ release: { draft: true } })
  await assert.rejects(publishRelease(input), /Draft release/)
  assert.equal(calls.length, 1)
})

for (const annotated of [false, true]) {
  test(`reuses a matching ${annotated ? 'annotated' : 'lightweight'} tag after a partial failure`, async () => {
    const { input, calls } = fixture({
      reference: { object: annotated ? { type: 'tag', sha: 'tag-sha' } : { type: 'commit', sha: 'tested-sha' } },
      annotated: { object: { type: 'commit', sha: 'tested-sha' } },
    })
    await publishRelease(input)
    assert.ok(!calls.some(({ method }) => method === 'createRef'))
    assert.equal(calls.at(-1).method, 'createRelease')
  })

  test(`rejects a conflicting ${annotated ? 'annotated' : 'lightweight'} tag`, async () => {
    const { input, calls } = fixture({
      reference: { object: { type: annotated ? 'tag' : 'commit', sha: 'other-sha' } },
      annotated: { object: { type: 'commit', sha: 'other-sha' } },
    })
    await assert.rejects(publishRelease(input), /refusing to overwrite/)
    assert.ok(!calls.some(({ method }) => method.startsWith('create')))
  })
}

test('bounds annotated tag traversal and rejects non-commit tags', async () => {
  for (const type of ['tag', 'tree']) {
    const { input, calls } = fixture({
      reference: { object: { type, sha: 'tag-sha' } },
      annotated: { object: { type, sha: 'tag-sha' } },
    })
    await assert.rejects(publishRelease(input), /refusing to overwrite/)
    assert.ok(calls.length <= 12)
  }
})

test('validates SemVer before any API call', async () => {
  for (const version of [undefined, 3, '', 'v0.3.0', '0.3', '01.3.0', '1.0.0-01', '1.0.0\n', '1.0.0\r', '1.0.0\u2028', '1.0.0; echo unsafe']) {
    const { input, calls } = fixture()
    await assert.rejects(publishRelease({ ...input, version }), /Invalid package version/)
    assert.equal(calls.length, 0)
  }
})

test('marks prereleases correctly without treating build metadata as a prerelease', async () => {
  for (const [version, prerelease] of [['1.0.0-rc.1', true], ['1.0.0-0+build', true], ['1.0.0+build-info', false]]) {
    const { input, calls } = fixture()
    await publishRelease({ ...input, version })
    assert.equal(calls.at(-1).params.prerelease, prerelease)
    assert.equal(calls.at(-1).params.make_latest, prerelease ? 'false' : 'legacy')
  }
})

test('refuses pull requests, tags and other branches before any API call', async () => {
  for (const [eventName, ref] of [['pull_request', 'refs/heads/main'], ['push', 'refs/heads/dev'], ['push', 'refs/tags/v0.3.0']]) {
    const { input, calls } = fixture()
    await assert.rejects(publishRelease({ ...input, context: { ...input.context, eventName, ref } }), /only allowed/)
    assert.equal(calls.length, 0)
  }
})

test('API failures are not mistaken for missing resources or retried as writes', async () => {
  for (const method of ['getReleaseByTag', 'getRef', 'createRef', 'createRelease']) {
    for (const status of [403, 422, 500]) {
      const error = Object.assign(new Error('API failed'), { status })
      const { input, calls } = fixture({ fail: { [method]: error } })
      await assert.rejects(publishRelease(input), (received) => received === error)
      assert.equal(calls.at(-1).method, method)
    }
  }
})

test('CI gates release on the test matrix and restricts write permission to the release job', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const [testing, release] = workflow.split('\n  release:\n')
  assert.match(testing, /contents: read/)
  assert.doesNotMatch(testing, /contents: write/)
  assert.match(testing, /node: \['22.x', '24.x'\]/)
  assert.match(release, /needs: test/)
  assert.match(release, /if: github.event_name == 'push' && github.ref == 'refs\/heads\/main'/)
  assert.match(release, /contents: write/)
  assert.match(release, /cancel-in-progress: false/)
  assert.match(release, /persist-credentials: false/)
  assert.match(release, /await publishRelease\(/)
})
