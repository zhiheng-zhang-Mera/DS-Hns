'use strict'

/**
 * Engineering Runtime: project adapters.
 *
 * A maintenance runtime must not be a Node.js tool that happens to accept other
 * repositories. An adapter is the whole of the runtime's knowledge about one kind
 * of project, and it is deliberately small: how to recognise the project, and
 * which commands the project itself defines for the operations the loop needs
 * (install, build, test, lint, typecheck, package).
 *
 * Three rules keep this honest:
 *
 *  1. **An adapter reads the project's own configuration.** The commands come from
 *     `package.json` scripts, a `Makefile` target, `Cargo.toml`, a Gradle task —
 *     not from a table of guesses about how a Node project usually works.
 *  2. **An inferred command is labelled as inferred.** When the project declares
 *     nothing usable, the adapter says so (`inferred: true`, with the evidence),
 *     because the plan requires an inferred command to be on the record.
 *  3. **Detection is evidence-based and ordered by specificity.** A repository with
 *     `Cargo.toml` and `package.json` is a Rust project with a Node helper, not the
 *     other way round.
 *
 * An adapter never runs anything by itself: it answers *what* the command would be
 * and *where* it must run. Execution belongs to the supervisor.
 */

const fs = require('node:fs')
const path = require('node:path')

/** The operations a project may declare. */
const OPERATIONS = Object.freeze(['install', 'build', 'test', 'focusedTest', 'lint', 'format', 'typecheck', 'package', 'run'])

/** How confident the runtime is in a discovered command. */
const CONFIDENCE = Object.freeze({
  DECLARED: 'declared',
  CONVENTION: 'convention',
  INFERRED: 'inferred'
})

function command(text, options = {}) {
  if (!text) return null
  return {
    command: String(text),
    cwd: options.cwd ? String(options.cwd) : null,
    confidence: options.confidence || CONFIDENCE.DECLARED,
    evidence: options.evidence ? String(options.evidence) : null,
    longRunning: options.longRunning === true,
    /** A focused variant takes a single test name or path as its argument. */
    acceptsFocus: options.acceptsFocus === true
  }
}

/** Read and parse a JSON file, or return null. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function exists(root, relative) {
  return fs.existsSync(path.join(root, relative))
}

function readText(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8')
  } catch {
    return null
  }
}

/** The scripts block of a package.json at `root`. */
function scriptsOf(root) {
  const parsed = readJson(path.join(root, 'package.json'))
  return parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null ? parsed.scripts : null
}

/** Does the project use a particular package manager? */
function packageManagerOf(root) {
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm'
  if (exists(root, 'yarn.lock')) return 'yarn'
  if (exists(root, 'bun.lockb')) return 'bun'
  if (exists(root, 'package-lock.json')) return 'npm'
  return exists(root, 'package.json') ? 'npm' : null
}

function runnerFor(manager) {
  return manager === 'npm' ? 'npm run' : manager
}

/**
 * Node.js / JavaScript / TypeScript.
 *
 * The test command prefers the project's own script, then a declared test
 * framework configuration, and only then the ecosystem convention — each labelled
 * with where it came from.
 */
function nodeAdapter() {
  return {
    id: 'node',
    language: 'javascript',
    /**
     * Detect from the manifest plus a source file, so a repository that merely
     * vendors a package.json is not claimed as a Node project.
     */
    detect(root) {
      if (!exists(root, 'package.json')) return null
      const source = ['src', 'lib', 'app', 'index.js', 'index.mjs', 'index.ts', 'test', 'tests'].some((entry) => exists(root, entry))
      return { score: source ? 90 : 60, evidence: source ? 'package.json with a source directory' : 'package.json only' }
    },
    commands(root) {
      const scripts = scriptsOf(root) || {}
      const manager = packageManagerOf(root) || 'npm'
      const run = runnerFor(manager)
      const has = (name) => typeof scripts[name] === 'string' && scripts[name].trim().length > 0
      const commands = {}
      const declared = (name, evidence) => command(`${run} ${name}`, { confidence: CONFIDENCE.DECLARED, evidence })

      commands.install = command(manager === 'pnpm' ? 'pnpm install --frozen-lockfile' : manager === 'yarn' ? 'yarn install --frozen-lockfile' : manager === 'bun' ? 'bun install' : 'npm ci', {
        confidence: CONFIDENCE.DECLARED,
        evidence: `lockfile for ${manager}`
      })
      if (has('build')) commands.build = declared('build', 'package.json scripts.build')
      if (has('test')) commands.test = declared('test', 'package.json scripts.test')
      if (has('lint')) commands.lint = declared('lint', 'package.json scripts.lint')
      if (has('format')) commands.format = declared('format', 'package.json scripts.format')
      if (has('typecheck')) commands.typecheck = declared('typecheck', 'package.json scripts.typecheck')
      if (has('dev')) commands.run = command(`${run} dev`, { confidence: CONFIDENCE.DECLARED, evidence: 'package.json scripts.dev', longRunning: true })
      if (has('start')) commands.run = commands.run || command(`${run} start`, { confidence: CONFIDENCE.DECLARED, evidence: 'package.json scripts.start', longRunning: true })

      // A focused test is a variant of the test command, not a second command: the
      // caller appends the failing file or test name.
      if (commands.test) commands.focusedTest = { ...commands.test, acceptsFocus: true }
      else if (exists(root, 'vitest.config.js') || exists(root, 'vitest.config.ts')) {
        commands.test = command('npx vitest run', { confidence: CONFIDENCE.CONVENTION, evidence: 'vitest.config' })
        commands.focusedTest = { ...commands.test, acceptsFocus: true }
      } else if (exists(root, 'jest.config.js') || exists(root, 'jest.config.cjs')) {
        commands.test = command('npx jest --ci', { confidence: CONFIDENCE.CONVENTION, evidence: 'jest.config' })
        commands.focusedTest = { ...commands.test, acceptsFocus: true }
      }
      if (!commands.build && exists(root, 'tsconfig.json')) {
        commands.build = command('npx tsc -p tsconfig.json --noEmit', { confidence: CONFIDENCE.CONVENTION, evidence: 'tsconfig.json' })
      }
      return commands
    },
    /** Node projects put their dependencies in a local tree. */
    artifacts(root) {
      const found = []
      for (const relative of ['node_modules', 'dist', 'build', 'coverage', '.next', 'out']) {
        if (exists(root, relative)) found.push(relative)
      }
      return found
    }
  }
}

/** Python. */
function pythonAdapter() {
  return {
    id: 'python',
    language: 'python',
    detect(root) {
      const markers = ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile', 'tox.ini', 'manage.py'].filter((entry) => exists(root, entry))
      if (!markers.length) return null
      return { score: markers.includes('pyproject.toml') ? 85 : 75, evidence: `python project markers: ${markers.join(', ')}` }
    },
    commands(root) {
      const commands = {}
      const usesPoetry = exists(root, 'poetry.lock') || (readText(root, 'pyproject.toml') || '').includes('[tool.poetry]')
      const usesPipenv = exists(root, 'Pipfile')
      const usesUv = exists(root, 'uv.lock')
      if (usesUv) commands.install = command('uv sync', { confidence: CONFIDENCE.DECLARED, evidence: 'uv.lock' })
      else if (usesPoetry) commands.install = command('poetry install', { confidence: CONFIDENCE.DECLARED, evidence: 'poetry' })
      else if (usesPipenv) commands.install = command('pipenv install --dev', { confidence: CONFIDENCE.DECLARED, evidence: 'Pipfile' })
      else if (exists(root, 'requirements.txt')) commands.install = command('python -m pip install -r requirements.txt', { confidence: CONFIDENCE.DECLARED, evidence: 'requirements.txt' })
      if (exists(root, 'pytest.ini') || exists(root, 'tox.ini') || (readText(root, 'pyproject.toml') || '').includes('pytest') || exists(root, 'tests')) {
        commands.test = command('python -m pytest', { confidence: exists(root, 'pytest.ini') ? CONFIDENCE.DECLARED : CONFIDENCE.CONVENTION, evidence: exists(root, 'pytest.ini') ? 'pytest.ini' : 'a tests directory or pytest configuration' })
        commands.focusedTest = { ...commands.test, acceptsFocus: true }
      }
      if (exists(root, 'ruff.toml') || (readText(root, 'pyproject.toml') || '').includes('ruff')) {
        commands.lint = command('python -m ruff check .', { confidence: CONFIDENCE.DECLARED, evidence: 'ruff configuration' })
        commands.format = command('python -m ruff format --check .', { confidence: CONFIDENCE.DECLARED, evidence: 'ruff configuration' })
      } else if (exists(root, '.flake8') || exists(root, 'setup.cfg')) {
        commands.lint = command('python -m flake8', { confidence: CONFIDENCE.DECLARED, evidence: 'flake8 configuration' })
      }
      if ((readText(root, 'pyproject.toml') || '').includes('mypy')) {
        commands.typecheck = command('python -m mypy .', { confidence: CONFIDENCE.DECLARED, evidence: 'mypy configuration' })
      }
      return commands
    },
    artifacts() {
      return []
    }
  }
}

/** Rust. */
function rustAdapter() {
  return {
    id: 'rust',
    language: 'rust',
    detect(root) {
      if (!exists(root, 'Cargo.toml')) return null
      return { score: 95, evidence: 'Cargo.toml' }
    },
    commands() {
      return {
        install: command('cargo fetch', { confidence: CONFIDENCE.CONVENTION, evidence: 'cargo' }),
        build: command('cargo build --all-targets', { confidence: CONFIDENCE.CONVENTION, evidence: 'cargo' }),
        test: command('cargo test', { confidence: CONFIDENCE.DECLARED, evidence: 'cargo test' }),
        focusedTest: command('cargo test', { confidence: CONFIDENCE.DECLARED, evidence: 'cargo test', acceptsFocus: true }),
        lint: command('cargo clippy --all-targets -- -D warnings', { confidence: CONFIDENCE.CONVENTION, evidence: 'clippy' }),
        format: command('cargo fmt --check', { confidence: CONFIDENCE.CONVENTION, evidence: 'rustfmt' }),
        package: command('cargo package --allow-dirty', { confidence: CONFIDENCE.CONVENTION, evidence: 'cargo' })
      }
    },
    artifacts(root) {
      return exists(root, 'target') ? ['target'] : []
    }
  }
}

/** Go. */
function goAdapter() {
  return {
    id: 'go',
    language: 'go',
    detect(root) {
      if (!exists(root, 'go.mod')) return null
      return { score: 95, evidence: 'go.mod' }
    },
    commands() {
      return {
        install: command('go mod download', { confidence: CONFIDENCE.CONVENTION, evidence: 'go modules' }),
        build: command('go build ./...', { confidence: CONFIDENCE.DECLARED, evidence: 'go build' }),
        test: command('go test ./...', { confidence: CONFIDENCE.DECLARED, evidence: 'go test' }),
        focusedTest: command('go test', { confidence: CONFIDENCE.DECLARED, evidence: 'go test', acceptsFocus: true }),
        lint: command('go vet ./...', { confidence: CONFIDENCE.CONVENTION, evidence: 'go vet' }),
        format: command('gofmt -l .', { confidence: CONFIDENCE.CONVENTION, evidence: 'gofmt' })
      }
    },
    artifacts() {
      return []
    }
  }
}

/** Java: Maven or Gradle. */
function javaAdapter() {
  return {
    id: 'java',
    language: 'java',
    detect(root) {
      if (exists(root, 'pom.xml')) return { score: 92, evidence: 'pom.xml' }
      if (exists(root, 'build.gradle') || exists(root, 'build.gradle.kts')) return { score: 92, evidence: 'build.gradle' }
      return null
    },
    commands(root) {
      const wrapper = (name) => (exists(root, name) ? (process.platform === 'win32' ? `${name}.bat` : `./${name}`) : null)
      if (exists(root, 'pom.xml')) {
        const mvn = wrapper('mvnw') || 'mvn'
        return {
          build: command(`${mvn} -B -DskipTests package`, { confidence: CONFIDENCE.CONVENTION, evidence: 'pom.xml' }),
          test: command(`${mvn} -B test`, { confidence: CONFIDENCE.CONVENTION, evidence: 'pom.xml' }),
          focusedTest: command(`${mvn} -B test`, { confidence: CONFIDENCE.CONVENTION, evidence: 'pom.xml', acceptsFocus: true }),
          package: command(`${mvn} -B package`, { confidence: CONFIDENCE.CONVENTION, evidence: 'pom.xml' })
        }
      }
      const gradle = wrapper('gradlew') || 'gradle'
      return {
        build: command(`${gradle} build -x test`, { confidence: CONFIDENCE.CONVENTION, evidence: 'build.gradle' }),
        test: command(`${gradle} test`, { confidence: CONFIDENCE.CONVENTION, evidence: 'build.gradle' }),
        focusedTest: command(`${gradle} test`, { confidence: CONFIDENCE.CONVENTION, evidence: 'build.gradle', acceptsFocus: true }),
        package: command(`${gradle} assemble`, { confidence: CONFIDENCE.CONVENTION, evidence: 'build.gradle' })
      }
    },
    artifacts(root) {
      const found = []
      for (const relative of ['target', 'build']) if (exists(root, relative)) found.push(relative)
      return found
    }
  }
}

/** .NET. */
function dotnetAdapter() {
  return {
    id: 'dotnet',
    language: 'csharp',
    detect(root) {
      let entries = []
      try {
        entries = fs.readdirSync(root)
      } catch {
        return null
      }
      const project = entries.find((entry) => entry.endsWith('.sln') || entry.endsWith('.csproj'))
      if (!project) return null
      return { score: 90, evidence: project }
    },
    commands() {
      return {
        install: command('dotnet restore', { confidence: CONFIDENCE.CONVENTION, evidence: 'dotnet' }),
        build: command('dotnet build --nologo', { confidence: CONFIDENCE.CONVENTION, evidence: 'dotnet' }),
        test: command('dotnet test --nologo', { confidence: CONFIDENCE.CONVENTION, evidence: 'dotnet' }),
        focusedTest: command('dotnet test --nologo --filter', { confidence: CONFIDENCE.CONVENTION, evidence: 'dotnet', acceptsFocus: true }),
        package: command('dotnet pack --nologo', { confidence: CONFIDENCE.CONVENTION, evidence: 'dotnet' })
      }
    },
    artifacts(root) {
      const found = []
      for (const relative of ['bin', 'obj']) if (exists(root, relative)) found.push(relative)
      return found
    }
  }
}

/** CMake. */
function cmakeAdapter() {
  return {
    id: 'cmake',
    language: 'c',
    detect(root) {
      if (!exists(root, 'CMakeLists.txt')) return null
      return { score: 88, evidence: 'CMakeLists.txt' }
    },
    commands() {
      return {
        build: command('cmake --build build', { confidence: CONFIDENCE.CONVENTION, evidence: 'CMakeLists.txt' }),
        test: command('ctest --test-dir build --output-on-failure', { confidence: CONFIDENCE.CONVENTION, evidence: 'CMakeLists.txt' }),
        focusedTest: command('ctest --test-dir build -R', { confidence: CONFIDENCE.CONVENTION, evidence: 'CMakeLists.txt', acceptsFocus: true })
      }
    },
    artifacts(root) {
      return exists(root, 'build') ? ['build'] : []
    }
  }
}

/** A Makefile project: the targets are the interface. */
function makeAdapter() {
  return {
    id: 'make',
    language: 'generic',
    detect(root) {
      if (!exists(root, 'Makefile') && !exists(root, 'makefile')) return null
      return { score: 70, evidence: 'Makefile' }
    },
    commands(root) {
      const text = readText(root, 'Makefile') || readText(root, 'makefile') || ''
      const has = (target) => new RegExp(`^${target}\\s*:`, 'm').test(text)
      const commands = {}
      if (has('all')) commands.build = command('make all', { confidence: CONFIDENCE.DECLARED, evidence: 'Makefile target all' })
      if (has('test')) commands.test = command('make test', { confidence: CONFIDENCE.DECLARED, evidence: 'Makefile target test' })
      if (has('check')) commands.test = commands.test || command('make check', { confidence: CONFIDENCE.DECLARED, evidence: 'Makefile target check' })
      if (has('lint')) commands.lint = command('make lint', { confidence: CONFIDENCE.DECLARED, evidence: 'Makefile target lint' })
      if (has('fmt')) commands.format = command('make fmt', { confidence: CONFIDENCE.DECLARED, evidence: 'Makefile target fmt' })
      if (has('install')) commands.install = command('make install', { confidence: CONFIDENCE.DECLARED, evidence: 'Makefile target install' })
      return commands
    },
    artifacts() {
      return []
    }
  }
}

/**
 * The fallback for a project nobody recognises.
 *
 * It claims nothing it cannot see: it looks for the markers a command could be
 * inferred from and reports each one as *inferred* with the evidence it used, so
 * the episode's record says exactly which command was guessed and why.
 */
function genericAdapter() {
  return {
    id: 'generic',
    language: 'unknown',
    detect() {
      return { score: 1, evidence: 'no known project manifest was found' }
    },
    commands(root) {
      const commands = {}
      let entries = []
      try {
        entries = fs.readdirSync(root)
      } catch {
        return commands
      }
      const has = (name) => entries.includes(name)
      if (has('Makefile') || has('makefile')) commands.build = command('make', { confidence: CONFIDENCE.INFERRED, evidence: 'a Makefile exists' })
      if (has('build.sh')) commands.build = commands.build || command(process.platform === 'win32' ? 'bash build.sh' : './build.sh', { confidence: CONFIDENCE.INFERRED, evidence: 'build.sh exists' })
      if (has('test.sh')) commands.test = command(process.platform === 'win32' ? 'bash test.sh' : './test.sh', { confidence: CONFIDENCE.INFERRED, evidence: 'test.sh exists' })
      if (has('scripts')) {
        let scriptEntries = []
        try {
          scriptEntries = fs.readdirSync(path.join(root, 'scripts'))
        } catch {
          scriptEntries = []
        }
        if (!commands.test && scriptEntries.some((entry) => /^test/i.test(entry))) {
          commands.test = command('npm test', { confidence: CONFIDENCE.INFERRED, evidence: 'a scripts/test* file exists but no manifest declares it' })
        }
      }
      return commands
    },
    artifacts() {
      return []
    }
  }
}

/** Every shipped adapter, most specific first. */
function defaultAdapters() {
  return [rustAdapter(), goAdapter(), dotnetAdapter(), javaAdapter(), cmakeAdapter(), pythonAdapter(), nodeAdapter(), makeAdapter(), genericAdapter()]
}

module.exports = {
  OPERATIONS,
  CONFIDENCE,
  command,
  nodeAdapter,
  pythonAdapter,
  rustAdapter,
  goAdapter,
  javaAdapter,
  dotnetAdapter,
  cmakeAdapter,
  makeAdapter,
  genericAdapter,
  defaultAdapters,
  packageManagerOf,
  readJson,
  readText,
  exists
}
