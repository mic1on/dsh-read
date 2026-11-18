const numeric = '(0|[1-9][0-9]*)'
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
const semver = new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)

async function optionalResource(request) {
  try {
    return (await request()).data
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

export async function publishRelease({ github, context, core, version }) {
  if (context.eventName !== 'push' || context.ref !== 'refs/heads/main') {
    throw new Error('Releases are only allowed for pushes to main')
  }
  if (typeof version !== 'string' || version !== version.trim() || !semver.test(version)) {
    throw new Error(`Invalid package version: ${version}`)
  }

  const tag = `v${version}`
  const repo = context.repo
  const release = await optionalResource(() => github.rest.repos.getReleaseByTag({ ...repo, tag }))
  if (release) {
    if (release.draft) throw new Error(`Draft release ${tag} already exists; review it manually`)
    core.info(`Release ${tag} already exists; skipping`)
    return
  }

  const reference = await optionalResource(() => github.rest.git.getRef({ ...repo, ref: `tags/${tag}` }))
  if (reference) {
    let object = reference.object
    for (let depth = 0; object.type === 'tag' && depth < 10; depth++) {
      object = (await github.rest.git.getTag({ ...repo, tag_sha: object.sha })).data.object
    }
    if (object.type !== 'commit' || object.sha !== context.sha) {
      throw new Error(`Tag ${tag} does not point to tested commit ${context.sha}; refusing to overwrite`)
    }
  } else {
    await github.rest.git.createRef({ ...repo, ref: `refs/tags/${tag}`, sha: context.sha })
  }

  const prerelease = version.split('+')[0].includes('-')
  const { data } = await github.rest.repos.createRelease({
    ...repo,
    tag_name: tag,
    target_commitish: context.sha,
    name: tag,
    generate_release_notes: true,
    draft: false,
    prerelease,
    make_latest: prerelease ? 'false' : 'legacy',
  })
  core.info(`Published ${data.html_url}`)
}
