// The redesign's stroke icons (src/assets/icons/*.svg, 2px stroke, currentColor) as
// React components via vite-plugin-svgr. Use: <Icon name="heart" size={18} />.
const modules = import.meta.glob("../../assets/icons/*.svg", { query: "?react", import: "default", eager: true });

const ICONS = Object.fromEntries(
  Object.entries(modules).map(([path, Comp]) => [path.split("/").pop().replace(".svg", ""), Comp]),
);

export function Icon({ name, size = 18, className = "", ...rest }) {
  const Comp = ICONS[name];
  if (!Comp) return null;
  return <Comp width={size} height={size} className={className} aria-hidden="true" focusable="false" {...rest} />;
}
