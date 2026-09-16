# Source this file from ~/.bashrc. Foreground process; Ctrl-C stops it.
start_kebiao() {
    local kebiao_dir="${KEBIAO_DIR:-$HOME/kebiao}"
    local kebiao_port="${1:-${KEBIAO_PORT:-3001}}"
    if [ "$#" -gt 0 ]; then shift; fi
    node "${kebiao_dir}/src/server.js" --port "$kebiao_port" "$@"
}
