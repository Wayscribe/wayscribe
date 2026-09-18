/**
 * A configuration the process cannot start with, in words that name the
 * settings to change.
 *
 * Its own module so that the settings read from files can throw it without
 * importing the loader that calls them.
 */
export class ConfigError extends Error {
  public override readonly name = "ConfigError";
}
