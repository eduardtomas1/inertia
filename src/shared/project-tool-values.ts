/** Native agents expand these forms, including references nested in values. */
export function hasProjectToolEnvironmentTemplate(value: string): boolean {
  return /\$(?:\{|[A-Za-z_])/u.test(value);
}

export function isProjectToolBearerToken(value: string | null | undefined): value is string {
  return !!value && value.length >= 8 && value.length <= 8192
    && !/[\r\n\x00]/u.test(value) && !hasProjectToolEnvironmentTemplate(value);
}
