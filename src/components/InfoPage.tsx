import type { ReactNode } from "react";
import styles from "@/app/page.module.css";

type InfoSection = {
  eyebrow: string;
  title: string;
  content: ReactNode;
};

type InfoPageProps = {
  eyebrow: string;
  title: string;
  intro: string;
  sections: InfoSection[];
};

/**
 * Renders the shared editorial layout used by public information pages.
 *
 * @param props The page label, heading, introduction, and content sections.
 * @returns A styled information page.
 */
export default function InfoPage({ eyebrow, title, intro, sections }: InfoPageProps) {
  return (
    <div className={styles.infoPage}>
      <div className={styles.pageIntro}>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{intro}</p>
      </div>
      {sections.map((section) => (
        <section className={styles.infoSection} key={section.title}>
          <div className={styles.sectionHeading}>
            <span className="eyebrow">{section.eyebrow}</span>
            <h2>{section.title}</h2>
          </div>
          <div className={styles.infoCopy}>{section.content}</div>
        </section>
      ))}
    </div>
  );
}
