# Shared by backup.sh and restore.sh (sourced, not executed). Both scripts `cd`
# to the repo root before sourcing this, so relative paths below are relative to
# the repo root.
#
# Why this exists: docker compose reads the repo's .env for variable
# interpolation, so the `postgres` container is created with whatever
# POSTGRES_USER/POSTGRES_DB that file says. These scripts run `pg_dump -U <user>
# <db>` themselves, so they must use the SAME values — a shop whose .env sets a
# non-default user or database would otherwise dump (or restore over) the wrong
# one. Bash does not read .env on its own, and cron starts with an almost empty
# environment, so the scripts load the few keys they need from it here.

# The compose invocation both scripts use for EVERY docker compose call (exec,
# stop, start) and print in every message that tells the operator what to run,
# so the two can never disagree. The prod overlay is what defines the `postgres`
# service these scripts exec into.
BACKUP_COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml)
BACKUP_COMPOSE_TEXT="docker compose -f docker-compose.yml -f docker-compose.postgres.prod.yml"

# The env file to read. Overridable only so the shell tests can point at a
# fixture instead of the developer's real .env.
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-.env}"

# Prints the value of KEY from the dotenv file FILE, or returns 1 when the file
# or the key is missing. The file is parsed as plain KEY=VALUE text and NEVER
# sourced or evaluated, so a value like `$(cmd)` stays literal text — .env holds
# every secret of the shop and is not a shell script. Handles what docker
# compose's own .env syntax allows for these simple values: an optional
# `export ` prefix, single or double quotes around the value, a trailing
# ` # comment` after an unquoted value, CRLF line endings, and repeated keys
# (the last one wins).
read_dotenv_value() {
  local file="$1" key="$2" line value found="" matched=0
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      "export "*)
        line="${line#export }"
        line="${line#"${line%%[![:space:]]*}"}"
        ;;
    esac
    case "$line" in
      "$key="*) ;;
      *) continue ;;
    esac
    value="${line#"$key="}"
    case "$value" in
      \"*)
        value="${value#\"}"
        value="${value%%\"*}"
        ;;
      \'*)
        value="${value#\'}"
        value="${value%%\'*}"
        ;;
      *)
        value="${value%%[[:space:]]#*}"
        value="${value%"${value##*[![:space:]]}"}"
        ;;
    esac
    found="$value"
    matched=1
  done < "$file"
  [ "$matched" = 1 ] || return 1
  printf '%s' "$found"
}

# For each KEY given: when the environment does not already set it, load it from
# $BACKUP_ENV_FILE. The environment wins, exactly as docker compose itself
# prefers a shell variable over .env when interpolating. Values are assigned
# with `printf -v`, never `eval`, and are never printed — callers decide what
# is safe to show (a database or user name is; a password never is, and is
# never requested from here).
load_env_defaults() {
  local key value
  for key in "$@"; do
    case "$key" in
      [A-Z_]*) ;;
      *) echo "ERROR: load_env_defaults: invalid key name: $key" >&2; return 1 ;;
    esac
    case "$key" in
      *[!A-Z0-9_]*) echo "ERROR: load_env_defaults: invalid key name: $key" >&2; return 1 ;;
    esac
    if [ -n "${!key+x}" ]; then
      continue
    fi
    if value="$(read_dotenv_value "$BACKUP_ENV_FILE" "$key")"; then
      printf -v "$key" '%s' "$value"
    fi
  done
}
