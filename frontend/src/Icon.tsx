// The shared dimOS line icons this page uses (paths from dim-icons.js); size follows font-size, color follows text.
const PATHS: Record<string, string> = {
    "chevron-left": "m15 6-6 6 6 6",
    "chevron-right": "m9 6 6 6-6 6",
    stop: "M6 6h12v12H6z",
}

export function Icon({ name }: { name: string }) {
    return (
        <svg className="dim-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d={PATHS[name] ?? ""} />
        </svg>
    )
}
