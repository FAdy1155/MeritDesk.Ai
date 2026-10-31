// Country and area names as English-language publications write them, for
// the collectors here whose source states no country field and names the
// country only in a publication's title (USCIRF: "Religious Freedom in
// Somalia", "China's Codification of ..."). countriesInTitle returns the
// names exactly as the title writes them; the lookup key is folded by
// ../../country.ts (Myanmar and Burma, Turkiye and Turkey). Pure data and a
// pure function: no I/O.

const NAMES = [
  "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria",
  "Azerbaijan", "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia",
  "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burma", "Burundi", "Cabo Verde", "Cape Verde",
  "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros",
  "Democratic Republic of the Congo", "Republic of the Congo", "Congo", "Costa Rica", "Cote d'Ivoire", "Côte d'Ivoire",
  "Côte d’Ivoire", "Ivory Coast", "Croatia", "Cuba", "Cyprus", "Czechia", "Czech Republic", "Denmark", "Djibouti", "Dominica",
  "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Swaziland",
  "Ethiopia", "Fiji", "Finland", "France", "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala",
  "Guinea-Bissau", "Guinea", "Guyana", "Haiti", "Holy See", "Honduras", "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Iran",
  "Iraq", "Ireland", "Israel", "Italy", "Jamaica", "Japan", "Jordan", "Kazakhstan", "Kenya", "Kiribati", "Kosovo", "Kuwait",
  "Kyrgyzstan", "Kyrgyz Republic", "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania",
  "Luxembourg", "Macau", "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania",
  "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Namibia",
  "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Korea", "North Macedonia", "Macedonia",
  "Norway", "Oman", "Pakistan", "Palau", "Palestine", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland",
  "Portugal", "Qatar", "Romania", "Russia", "Rwanda", "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines",
  "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore",
  "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "Somaliland", "South Africa", "South Korea", "South Sudan", "Spain",
  "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Tibet",
  "Timor-Leste", "East Timor", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Türkiye", "Turkiye", "Turkmenistan",
  "Tuvalu", "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "Uruguay", "Uzbekistan", "Vanuatu",
  "Venezuela", "Vietnam", "Western Sahara", "Yemen", "Zambia", "Zimbabwe",
];

/** Longest first, so "South Sudan" is read before "Sudan" and "Papua New Guinea" before "Guinea". */
const BY_LENGTH = [...new Set(NAMES)].sort((a, b) => b.length - a.length);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The country and area names `title` contains as whole words (with their
 * capitals, as names are written), in the order they appear, each once:
 * the longest name wins where names overlap. `extra` adds names the source
 * itself lists (USCIRF's country filter).
 */
export function countriesInTitle(title: string, extra: readonly string[] = []): string[] {
  const names = extra.length ? [...new Set([...extra.map((e) => e.trim()).filter(Boolean), ...BY_LENGTH])].sort((a, b) => b.length - a.length) : BY_LENGTH;
  const taken: boolean[] = new Array(title.length).fill(false);
  const found: { at: number; name: string }[] = [];
  for (const name of names) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of title.matchAll(re)) {
      const at = m.index ?? 0;
      if (taken.slice(at, at + m[0].length).some(Boolean)) continue;
      for (let i = at; i < at + m[0].length; i++) taken[i] = true;
      found.push({ at, name: m[0] });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}
