export class MediaError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const fail = (message: string, status = 400): never => {
  throw new MediaError(message, status);
};
