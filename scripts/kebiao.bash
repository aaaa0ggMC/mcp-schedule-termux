# Source this file from ~/.bashrc. Foreground process; Ctrl-C stops it.
#
# Falls back to the repository this file lives in, so a clone under any directory
# name works; set KEBIAO_DIR to point somewhere else explicitly.
start_kebiao() {
    local kebiao_dir="${KEBIAO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
    local kebiao_port="${1:-${KEBIAO_PORT:-3001}}"
    if [ "$#" -gt 0 ]; then shift; fi
    node "${kebiao_dir}/src/server.js" --port "$kebiao_port" "$@"
}
