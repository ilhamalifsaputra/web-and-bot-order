import config from "../vitest.config";
// Isolated local test database; never load a production database for this run.
process.env.DATABASE_URL_PRISMA = "postgresql://multicurrency_test:multicurrency_test@127.0.0.1:55449/multicurrency_test";
process.env.pnpm_config_verify_deps_before_run = "false";
process.env.npm_config_pm_on_fail = "ignore";
export default config;
