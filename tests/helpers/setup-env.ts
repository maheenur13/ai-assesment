try {
  process.loadEnvFile();
} catch {
  // CI provides env directly.
}
