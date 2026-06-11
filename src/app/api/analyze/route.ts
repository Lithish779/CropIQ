import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth-options";
import { analyzeImageWithGemini, chatWithGemini } from "@/lib/gemini";
import { fastAnalysisWithGroq } from "@/lib/groq";
import connectDB from "@/lib/mongodb";
import Analysis from "@/models/Analysis";
import User from "@/models/User";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await request.formData();
    const image = formData.get("image") as File | null;
    const query = formData.get("query") as string;
    const type = (formData.get("type") as string) || "general";
    const cropName = formData.get("cropName") as string;
    const provider = (formData.get("provider") as string) || "gemini";

    if (!query) {
      return NextResponse.json({ error: "Query is required" }, { status: 400 });
    }

    let rawResponse = "";
    let aiProvider: "gemini" | "groq" | "combined" = "gemini";

    if (image && provider !== "groq") {
      // Image analysis with Gemini Vision
      const bytes = await image.arrayBuffer();
      const base64 = Buffer.from(bytes).toString("base64");
      const mimeType = image.type as string;

      const prompt = `Analyze this ${type === "crop_disease" ? "crop/plant image" : "agricultural image"} and provide:

1. DIAGNOSIS: What disease, pest, or issue do you see?
2. SEVERITY: Rate as Critical/High/Medium/Low/Healthy
3. CONFIDENCE: Your confidence percentage (0-100)
4. AFFECTED AREA: What percentage of the plant/area is affected?
5. TREATMENT: Step-by-step treatment plan
6. PREVENTION: Future prevention measures
7. EXPERT ADVICE: Should they consult an expert? When?

Additional context from user: "${query}"
${cropName ? `Crop: ${cropName}` : ""}

Please structure your response clearly with these sections.`;

      rawResponse = await analyzeImageWithGemini(base64, mimeType, prompt);
      aiProvider = "gemini";
    } else if (provider === "groq") {
      // Fast text analysis with Groq
      const analysisQuery = `${query}${cropName ? ` (Crop: ${cropName})` : ""}. Type: ${type}`;
      rawResponse = await fastAnalysisWithGroq(analysisQuery);
      aiProvider = "groq";
    } else {
      // Text-based Gemini analysis
      rawResponse = await chatWithGemini(query);
      aiProvider = "gemini";
    }

    // Parse the response into structured data
    const parsed = parseAIResponse(rawResponse);

    // Save to MongoDB
    await connectDB();
    const analysis = await Analysis.create({
      userId: (session.user as any).id,
      type,
      query,
      aiProvider,
      cropName,
      result: {
        ...parsed,
        rawResponse,
      },
      tags: extractTags(query, cropName, type),
    });

    // Increment user analysis count
    await User.findByIdAndUpdate((session.user as any).id, {
      $inc: { analysisCount: 1 },
    });

    return NextResponse.json({
      success: true,
      analysisId: analysis._id,
      result: {
        ...parsed,
        rawResponse,
      },
      aiProvider,
    });
  } catch (error: any) {
    console.error("Analyze error:", error);
    return NextResponse.json(
      { error: `Analysis failed: ${error?.message || error}` },
      { status: 500 }
    );
  }
}

function parseAIResponse(response: string) {
  const diagnosisMatch =
    response.match(/DIAGNOSIS[:\s]*([^\n]+(?:\n(?!SEVERITY|CONFIDENCE)[^\n]+)*)/i) ||
    response.match(/diagnosis[:\s]*([^\n]+)/i);
  
  const severityMatch =
    response.match(/SEVERITY[:\s]*(critical|high|medium|low|healthy)/i);
  
  const confidenceMatch =
    response.match(/CONFIDENCE[:\s]*(\d+)/i);
  
  const treatmentMatch =
    response.match(/TREATMENT[:\s]*([^\n]+(?:\n(?!PREVENTION|EXPERT)[^\n]+)*)/i);
  
  const preventionMatch =
    response.match(/PREVENTION[:\s]*([^\n]+(?:\n(?!EXPERT|DIAGNOSIS)[^\n]+)*)/i);
  
  const expertMatch =
    response.match(/EXPERT[^:]*[:\s]*([^\n]+(?:\n(?!DIAGNOSIS|SEVERITY)[^\n]+)*)/i);

  return {
    diagnosis: diagnosisMatch?.[1]?.trim() || extractFirstMeaningfulParagraph(response),
    severity: (severityMatch?.[1]?.toLowerCase() as any) || "medium",
    confidence: confidenceMatch ? parseInt(confidenceMatch[1]) : 75,
    treatment: treatmentMatch?.[1]?.trim() || "Please consult the full analysis below.",
    prevention: preventionMatch?.[1]?.trim() || "Follow standard agricultural best practices.",
    expertAdvice: expertMatch?.[1]?.trim() || undefined,
  };
}

function extractFirstMeaningfulParagraph(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim().length > 20);
  return lines[0] || text.substring(0, 200);
}

function extractTags(query: string, cropName: string, type: string): string[] {
  const tags = [type];
  if (cropName) tags.push(cropName.toLowerCase());
  const keywords = ["disease", "pest", "fungal", "bacterial", "viral", "drought", "irrigation"];
  keywords.forEach((kw) => {
    if (query.toLowerCase().includes(kw)) tags.push(kw);
  });
  return Array.from(new Set(tags));
}
