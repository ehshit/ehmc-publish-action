# Eh's Minecraft Publisher

Publishes to Modrinth/CurseForge/GitHub.

This exists because handling multiple jars for per game version into one workflow can be a pain

## Usage

```yaml
name: publish

on:
  workflow_dispatch:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build
        run: ./gradlew build

      - name: Publish
        uses: ehshit/ehmc-publish-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          modrinth-token: ${{ secrets.MODRINTH_TOKEN }}
          modrinth-id: FWCeQyRS
          curseforge-token: ${{ secrets.CURSEFORGE_TOKEN }}
          curseforge-id: "1830573"
          version: 1.1.8
          game-versions: |
            1.21.11
            26.1.2
            26.3
          files: |
            build/libs/1.1.8/*.jar
          primary-file: wildfireoverlimits-1.1.8.jar
```

If a token is invalid that plataform will be skipped

## Per-version matrix pattern

For Stonecutter projects, publish one Modrinth/CurseForge version per Minecraft version, then make one GitHub release containing all jars:

```yaml
jobs:
  prepare:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.meta.outputs.version }}
      matrix: ${{ steps.meta.outputs.matrix }}
    steps:
      - uses: actions/checkout@v4
      - id: meta
        run: |
          echo "version=1.1.8" >> "$GITHUB_OUTPUT"
          echo 'matrix={"include":[{"game_version":"1.21.11","artifact_version":"1.1.8","java":21,"featured":false},{"game_version":"26.3","artifact_version":"1.1.8-26.3","java":25,"featured":true}]}' >> "$GITHUB_OUTPUT"

  build:
    needs: prepare
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          java-version: 25
          distribution: temurin
      - run: ./gradlew buildAndCollect
      - uses: actions/upload-artifact@v4
        with:
          name: jars
          path: build/libs/${{ needs.prepare.outputs.version }}/

  publish-platforms:
    needs: [prepare, build]
    runs-on: ubuntu-latest
    strategy:
      matrix: ${{ fromJSON(needs.prepare.outputs.matrix) }}
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: jars
          path: build/libs/${{ needs.prepare.outputs.version }}
      - uses: ehshit/ehmc-publish-action@v1
        with:
          modrinth-token: ${{ secrets.MODRINTH_TOKEN }}
          modrinth-id: FWCeQyRS
          curseforge-token: ${{ secrets.CURSEFORGE_TOKEN }}
          curseforge-id: "1830573"
          version: v${{ needs.prepare.outputs.version }}+${{ matrix.game_version }}
          name: Over The Limits v${{ needs.prepare.outputs.version }} for ${{ matrix.game_version }}
          game-versions: ${{ matrix.game_version }}
          java: ${{ matrix.java }}
          modrinth-featured: ${{ matrix.featured }}
          files: |
            build/libs/${{ needs.prepare.outputs.version }}/wildfireoverlimits-${{ matrix.artifact_version }}.jar
            build/libs/${{ needs.prepare.outputs.version }}/wildfireoverlimits-${{ matrix.artifact_version }}-sources.jar
          primary-file: wildfireoverlimits-${{ matrix.artifact_version }}.jar
          dependencies: |
            fabric-api@1.0.0(required){modrinth:P7dR8mSH}{curseforge:306612}

  publish-github:
    needs: [prepare, build, publish-platforms]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: jars
          path: build/libs/${{ needs.prepare.outputs.version }}
      - uses: ehshit/ehmc-publish-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          github-tag: v${{ needs.prepare.outputs.version }}
          version: ${{ needs.prepare.outputs.version }}
          files: build/libs/${{ needs.prepare.outputs.version }}/*
```

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | no | `""` | Token used to create/update a GitHub release and upload assets. |
| `modrinth-token` | no | `""` | Modrinth API token. |
| `modrinth-id` | no | `""` | Modrinth project id. |
| `curseforge-token` | no | `""` | CurseForge API token. |
| `curseforge-id` | no | `""` | CurseForge project id. |
| `version` | yes | | Version number. |
| `version-type` | no | `release` | `release`, `beta`, or `alpha`. |
| `name` | no | `version` | Display name. |
| `changelog` | no | `""` | Changelog text. |
| `changelog-file` | no | `""` | Changelog file path, when `changelog` is empty. |
| `files` | yes | | Newline-separated globs for files to publish. |
| `primary-file` | no | first match | Primary file path or basename. |
| `game-versions` | no | `""` | Newline/comma-separated game versions. |
| `loaders` | no | `fabric` | Newline/comma-separated loaders. |
| `java` | no | `""` | Only because CurseForge wants to show `Java <n>`. |
| `dependencies` | no | `""` | Newline-separated dependency lines. |
| `github-tag` | no | `v<version>` | GitHub tag. |
| `github-repository` | no | caller repo | `owner/repo` for the GitHub release. |
| `github-draft` | no | `false` | Create the release as a draft. |
| `github-prerelease` | no | `false` | Mark the release as a prerelease. |
| `github-generate-notes` | no | `false` | Let GitHub generate release notes. |
| `modrinth-featured` | no | `false` | Mark the Modrinth version as featured. |
| `modrinth-status` | no | `listed` | `listed`, `archived`, `draft`, or `unlisted`. |
| `curseforge-changelog-type` | no | `markdown` | `text`, `html`, or `markdown`. |
| `curseforge-game-endpoint` | no | `minecraft` | CurseForge game endpoint. |

## Dependency syntax

```text
slug@version(required){modrinth:PROJECT_ID}{curseforge:PROJECT_ID}
```

Supported dependency types: `required`, `optional`, `incompatible`, `embedded`, and `tool`. `tool` which applies to CurseForge only

Example:

```text
fabric-api@0.141.6+1.21.11(required){modrinth:P7dR8mSH}{curseforge:306612}
modmenu@17.0.1(optional){modrinth:mOgUt4GM}{curseforge:308702}
yet_another_config_lib@3.8.1+1.21.11-fabric(required){modrinth:1eAoo2KR}{curseforge:667299}
```

## Outputs

| Output | Description |
| --- | --- |
| `github-release-url` | GitHub release URL. |
| `github-release-id` | GitHub release id. |
| `modrinth-version-id` | Modrinth version id. |
| `modrinth-version-url` | Modrinth URL using the project id and version id. |
| `curseforge-file-id` | Primary CurseForge file id. |

## Multiple game versions

One action call creates one Modrinth version and one CurseForge primary file, to give each jar its own game version, use a matrix and call the action once per game version

Set `modrinth-featured: true` on only the matrix row that should be featured.

The final GitHub job calls the action once with all jars, producing one GitHub release containing every jar

Example per-version logs:

```text
publish-platforms (1.21.11): Published to Modrinth: FWCeQyRS/3RTSORTa (https://modrinth.com/project/FWCeQyRS/version/3RTSORTa)
publish-platforms (1.21.11): Published to CurseForge: 1830573/<file-id>
publish-platforms (26.1.2): Published to Modrinth: FWCeQyRS/4Wb4VPcb (https://modrinth.com/project/FWCeQyRS/version/4Wb4VPcb)
publish-platforms (26.1.2): Published to CurseForge: 1830573/<file-id>
publish-platforms (26.3): Published to Modrinth: FWCeQyRS/YjxoR8WA (https://modrinth.com/project/FWCeQyRS/version/YjxoR8WA)
publish-platforms (26.3): Published to CurseForge: 1830573/<file-id>
publish-github: Uploaded wildfireoverlimits-1.1.8.jar to https://github.com/.../releases/download/v1.1.8/wildfireoverlimits-1.1.8.jar
publish-github: Uploaded wildfireoverlimits-1.1.8-26.3.jar to https://github.com/.../releases/download/v1.1.8/wildfireoverlimits-1.1.8-26.3.jar
```