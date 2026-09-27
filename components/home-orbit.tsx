import Image from "next/image";
import Link from "next/link";
import { ink } from "@/lib/utils";

/**
 * The home page's centrepiece: the G at the centre, the networks we cover in
 * orbit around it on two dashed rings turning in opposite directions.
 *
 * Each mark rides its ring and counter-rotates at the same speed, so the logos
 * stay upright while the ring turns. Pure CSS; hovering the orbit pauses it,
 * and prefers-reduced-motion stops it (the global rule in globals.css).
 */

export interface OrbitMark {
  key: string;
  href: string;
  name: string;
  accent: string;
  symbol: string;
  logo: string | null;
}

function Ring({
  marks,
  radius,
  duration,
  reverse,
  offset,
}: {
  marks: OrbitMark[];
  radius: number;
  duration: number;
  reverse?: boolean;
  offset: number;
}) {
  const size = radius * 2;
  return (
    <div
      className="gata-orbit-ring absolute left-1/2 top-1/2 rounded-full border border-dashed"
      style={{
        width: size,
        height: size,
        marginLeft: -radius,
        marginTop: -radius,
        borderColor: "color-mix(in srgb, var(--gata-blue) 26%, transparent)",
        animation: `${reverse ? "gataSpinRev" : "gataSpin"} ${duration}s linear infinite`,
      }}
    >
      {marks.map((m, i) => {
        const angle = offset + (360 / marks.length) * i;
        return (
          <div
            key={m.key}
            className="absolute left-1/2 top-1/2"
            style={{
              transform: `rotate(${angle}deg) translate(${radius}px) rotate(${-angle}deg)`,
            }}
          >
            {/* Counter-rotation keeps the logo upright as the ring turns. */}
            <div
              className="gata-orbit-ring -ml-5 -mt-5"
              style={{
                animation: `${reverse ? "gataSpin" : "gataSpinRev"} ${duration}s linear infinite`,
              }}
            >
              <Link
                href={m.href}
                title={m.name}
                aria-label={m.name}
                className="group/mark grid h-10 w-10 place-items-center rounded-full border bg-[var(--gata-card)] transition-transform duration-200 hover:scale-125"
                style={{
                  borderColor: `color-mix(in srgb, ${m.accent} 55%, transparent)`,
                  boxShadow: `0 0 18px -4px color-mix(in srgb, ${m.accent} 70%, transparent)`,
                }}
              >
                {m.logo ? (
                  <Image
                    src={m.logo}
                    alt=""
                    width={26}
                    height={26}
                    className="h-[26px] w-[26px] rounded-full object-contain"
                  />
                ) : (
                  <span
                    className="text-[9px] font-semibold"
                    style={{ color: ink(m.accent) }}
                  >
                    {m.symbol.slice(0, 3)}
                  </span>
                )}
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function HomeOrbit({ marks }: { marks: OrbitMark[] }) {
  // Inner ring takes the first few, outer the rest: fewer marks on the
  // smaller circle so they never crowd.
  const innerCount = Math.min(4, Math.floor(marks.length / 2));
  const inner = marks.slice(0, innerCount);
  const outer = marks.slice(innerCount);

  return (
    <nav
      className="gata-orbit relative mx-auto h-[336px] w-[336px] max-w-full"
      aria-label="Networks"
    >
      {/* Soft glow behind the centre. */}
      <div
        aria-hidden="true"
        className="absolute inset-[18%] rounded-full blur-2xl"
        style={{
          background:
            "radial-gradient(closest-side, var(--gata-glow), transparent)",
        }}
      />
      <div className="absolute inset-0">
        <Ring marks={outer} radius={150} duration={90} offset={-90} />
        <Ring marks={inner} radius={92} duration={60} reverse offset={-45} />
        {/* A thin ring hugging the centre, turning slowly. */}
        <div
          aria-hidden="true"
          className="gata-orbit-ring absolute left-1/2 top-1/2 -ml-[46px] -mt-[46px] h-[92px] w-[92px] rounded-full border border-dashed"
          style={{
            borderColor:
              "color-mix(in srgb, var(--gata-blue) 45%, transparent)",
            animation: "gataSpin 34s linear infinite",
          }}
        />
        <div className="absolute left-1/2 top-1/2 -ml-8 -mt-8 grid h-16 w-16 place-items-center rounded-full border border-[var(--gata-border-hi)] bg-[var(--gata-card)] shadow-[0_0_40px_-6px_var(--gata-glow)]">
          <Image
            src="/gata_logo_white.png"
            alt="GATA"
            width={30}
            height={33}
            priority
            className="gata-mark h-8 w-auto"
          />
        </div>
      </div>
    </nav>
  );
}
