// a service schema, read as text so a spec can stand up the real server it describes
declare module "*.rayfold" {
  const text: string;
  export default text;
}
