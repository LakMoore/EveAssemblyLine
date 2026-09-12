import { Check, X } from "lucide-react";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import styles from "@/app/page.module.css";

export type PlannerSkillCharacter = {
  characterId: number;
  name: string;
  skillsAvailable: boolean;
  skills: Array<{
    skillId: number;
    name: string;
    currentLevel: number;
    requiredLevel: number;
  }>;
};

type PlannerSkillsTabProps = {
  requiredSkillCount: number;
  characters: PlannerSkillCharacter[];
};

/** Renders required-skill coverage for each attached character. */
export default function PlannerSkillsTab({
  requiredSkillCount,
  characters,
}: PlannerSkillsTabProps) {
  return (
    <div className={styles.skillsResult}>
      <div className={styles.skillsSummary}>
        <strong>{requiredSkillCount.toLocaleString()} required skills</strong>
        <span>Only insufficient skills are shown for each character.</span>
      </div>
      {characters.length === 0 ? (
        <Empty className={styles.emptyResult}>
          <div className={styles.resultGlyph}>?</div>
          <strong>Character skills are unavailable</strong>
          <EmptyDescription>
            Connect a character and refresh status to compare trained skills.
          </EmptyDescription>
        </Empty>
      ) : characters.every((character) => character.skills.length === 0) ? (
        <Empty className={styles.emptyResult}>
          <div className={styles.resultGlyph}>✓</div>
          <strong>All characters meet the requirements</strong>
          <EmptyDescription>
            No insufficient skills were found in the cached character status.
          </EmptyDescription>
        </Empty>
      ) : (
        <div className={styles.skillsCharacters}>
          {characters.map((character) => (
            <section className={styles.skillsCharacter} key={character.characterId}>
              <header className={styles.skillsCharacterHeader}>
                <strong>{character.name}</strong>
                {character.skillsAvailable ? (
                  character.skills.length === 0 ? (
                    <span className={styles.skillsComplete}>
                      All required skills trained
                      <Check aria-hidden="true" />
                    </span>
                  ) : (
                    <span className={styles.skillsInsufficient}>
                      {character.skills.length} MISSING SKILL
                      {character.skills.length === 1 ? "" : "S"}
                      {character.skills.some((skill) => skill.currentLevel > 0)
                        ? ` (${character.skills.filter((skill) => skill.currentLevel > 0).length} PARTIAL)`
                        : ""}
                      <X aria-hidden="true" />
                    </span>
                  )
                ) : (
                  <span className={styles.skillsUnavailable}>Status unavailable</span>
                )}
              </header>
              {!character.skillsAvailable ? (
                <p className={styles.skillsUnavailable}>
                  Refresh character status to compare skills.
                </p>
              ) : character.skills.length > 0 ? (
                <div className={styles.skillsRows}>
                  {character.skills.map((skill) => (
                    <div className={styles.skillRow} key={skill.skillId}>
                      <span>{skill.name}</span>
                      <strong>
                        {skill.currentLevel} / {skill.requiredLevel}
                      </strong>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
