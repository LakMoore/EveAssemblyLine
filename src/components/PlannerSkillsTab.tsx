import { Check, CircleHelp, X } from "lucide-react";
import type { ClientCharacterStatus } from "@/lib/client/requestCache";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";

export type PlannerSkillRequirement = {
  skillId: number;
  name: string;
  requiredLevel: number;
};

type PlannerSkillsTabProps = {
  requirements: readonly PlannerSkillRequirement[];
  characters: readonly ClientCharacterStatus[];
  characterNamesById: ReadonlyMap<number, string>;
};

/** Compares each character's cached skills with the simulation requirements. */
export default function PlannerSkillsTab({
  requirements,
  characters,
  characterNamesById,
}: PlannerSkillsTabProps) {
  const coverage = characters.map((character) => {
    const skillsAvailable =
      character.skills?.hasBody === true && Array.isArray(character.skills.body);
    const trainedLevels = new Map(
      (character.skills?.body ?? []).map((skill) => [skill.skillId, skill.activeSkillLevel]),
    );
    const missingSkills = skillsAvailable
      ? requirements
          .filter((skill) => (trainedLevels.get(skill.skillId) ?? 0) < skill.requiredLevel)
          .map((skill) => ({
            ...skill,
            currentLevel: trainedLevels.get(skill.skillId) ?? 0,
          }))
      : [];

    return {
      characterId: character.characterId,
      name: characterNamesById.get(character.characterId) ?? `Character ${character.characterId}`,
      skillsAvailable,
      missingSkills,
      trainedSkillCount: skillsAvailable ? requirements.length - missingSkills.length : 0,
    };
  });
  const availableCharacterCount = coverage.filter((character) => character.skillsAvailable).length;
  const readyCharacterCount = coverage.filter(
    (character) => character.skillsAvailable && character.missingSkills.length === 0,
  ).length;
  const unavailableCharacterCount = coverage.length - availableCharacterCount;
  const readinessPercent =
    availableCharacterCount === 0 ? 0 : (readyCharacterCount / availableCharacterCount) * 100;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="grid gap-3 border-b pb-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-medium">Character skill readiness</h3>
          <p className="text-sm text-muted-foreground">
            {readyCharacterCount} of {availableCharacterCount} characters with skill data meet all{" "}
            {requirements.length} required skills.
            {unavailableCharacterCount > 0 && ` ${unavailableCharacterCount} unavailable.`}
          </p>
        </div>
        {availableCharacterCount > 0 && (
          <Progress
            value={readinessPercent}
            aria-label="Characters meeting all required skills"
            className="w-full sm:w-40"
          />
        )}
      </section>
      {coverage.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No character skill data</EmptyTitle>
            <EmptyDescription>
              Connect a character and refresh status to compare trained skills.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid min-w-0 gap-3">
          {coverage.map((character) => (
            <Card key={character.characterId} size="sm">
              <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <CardTitle className="wrap-break-word">{character.name}</CardTitle>
                  <CardDescription>
                    {character.skillsAvailable
                      ? `${character.trainedSkillCount} of ${requirements.length} requirements met`
                      : "Skill data unavailable"}
                  </CardDescription>
                </div>
                {character.skillsAvailable ? (
                  character.missingSkills.length === 0 ? (
                    <Badge>
                      <Check aria-hidden="true" />
                      Ready
                    </Badge>
                  ) : (
                    <Badge variant="destructive">
                      <X aria-hidden="true" />
                      {character.missingSkills.length} missing
                    </Badge>
                  )
                ) : (
                  <Badge variant="secondary">
                    <CircleHelp aria-hidden="true" />
                    Unknown
                  </Badge>
                )}
              </CardHeader>
              {!character.skillsAvailable ? (
                <CardContent className="border-t pt-3 text-sm text-muted-foreground">
                  Refresh character status to check skill requirements.
                </CardContent>
              ) : character.missingSkills.length > 0 ? (
                <CardContent className="border-t pt-1">
                  <ul className="divide-y">
                    {character.missingSkills.map((skill) => {
                      return (
                        <li
                          className="flex min-w-0 items-center justify-between gap-4 py-2 text-sm"
                          key={skill.skillId}
                        >
                          <span className="min-w-0 wrap-break-word">{skill.name}</span>
                          <span className="shrink-0 font-mono text-muted-foreground">
                            {skill.currentLevel} / {skill.requiredLevel}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
