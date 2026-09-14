/** Redact URL user-info with a monotonic scan rather than retrying long schemes. */
export function redactCredentialUrls(value: string): string {
  let copied = 0;
  let cursor = 0;
  let output = "";
  for (;;) {
    const delimiter = value.indexOf("://", cursor);
    if (delimiter < 0) break;
    let start = delimiter;
    while (start > cursor && /[a-z0-9+.-]/iu.test(value[start - 1])) start -= 1;
    let end = delimiter + 3;
    let lastAt = -1;
    while (end < value.length && !/[\s/?#]/u.test(value[end])) {
      if (value[end] === "@") lastAt = end;
      end += 1;
    }
    if (start < delimiter && /[a-z]/iu.test(value[start]) && lastAt >= 0) {
      output += value.slice(copied, delimiter + 3) + "<redacted>@";
      copied = lastAt + 1;
    }
    cursor = end;
  }
  return output + value.slice(copied);
}

/** Remove a credential prefix exposed by truncation, scanning only its final token. */
export function removeTrailingSecretFragment(value: string): string {
  let tokenStart = value.length;
  while (tokenStart > 0 && !/\s/u.test(value[tokenStart - 1])) tokenStart -= 1;
  const token = value.slice(tokenStart);
  const prefix = /\b(?:(?:sk|rk|pk|api|key|token)[-_]|eyJ)/iu.exec(token);
  if (prefix && /^[A-Za-z0-9_.-]*$/u.test(token.slice(prefix.index))) {
    return value.slice(0, tokenStart + prefix.index);
  }
  const authorization = /\b(?:Bearer|Basic)\s+$/iu.exec(value.slice(0, tokenStart));
  return authorization ? value.slice(0, authorization.index) : value;
}
