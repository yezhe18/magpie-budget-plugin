# Source and licenses

The plugin and linked AntSeed code are distributed under GPL-3.0-only.
FreeLLMAPI and Magpie retain their MIT notices. The plugin does not include
the Magpie executable or any Node/Bun executable.

`source.tar.gz` contains the corresponding core, integration and build source,
locked build dependencies, the source inputs of bundled JavaScript packages,
and a reproduction guide. Full notices for imported packages are under
`licenses/dependencies/`; esbuild's retained legal comments are beside the bundles.

The unmodified node-datachannel 0.7.0 N-API 8 binaries are pinned in
`native-artifacts.json`. Its wrapper has one local change: selecting the
bundled binary for the current platform. The wrapper and its MPL-2.0 notice
are included under `node_modules/node-datachannel`. Native binding source:
https://github.com/murat-dogan/node-datachannel/tree/v0.7.0
Native build instructions and linked dependency source are available in that
revision's CMake configuration and submodules. No native binary is compiled
or downloaded when the plugin is installed or runs.
