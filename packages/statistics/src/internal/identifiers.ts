export const isIdentifierColumn = (name: string) => {
  const trimmed = name.trim();
  return /^(?:id|uuid|guid)$/i.test(trimmed)
    || /^(?:response|respondent|participant|subject|record)[_\-\s]?id$/i.test(trimmed)
    || /[a-z]Id$/.test(trimmed)
    || /(?:[_\-\s]id)$/i.test(trimmed)
    || /(?:[^A-Z]|^)ID$/.test(trimmed);
};
