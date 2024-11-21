import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { useSettingsStore } from '../stores/settingsStore';

const MAX_CHUNK_SIZE = 4000; // Tokens, leaving room for response

export interface AIAnalysisResult {
  metrics: {
    complexity: number;
    completeness: number;
    efficiency: number;
  };
  suggestions: {
    improvements: Array<{
      id: string;
      type: 'improvement' | 'warning' | 'validation';
      message: string;
      impact: 'high' | 'medium' | 'low';
      recommendation: string;
      autoFixAvailable: boolean;
      section: string;
      category: string;
    }>;
  };
  studySchedule: {
    visits: Array<{
      name: string;
      window: string;
      procedures: Array<{
        name: string;
        required: boolean;
        notes?: string;
      }>;
    }>;
    procedures: string[];
  };
  sectionMetrics: {
    [sectionName: string]: {
      complexity: number;
      completeness: number;
      efficiency: number;
    };
  };
}

export interface FinalDocuments {
  protocol: string;
  schedule: {
    visits: Array<{
      name: string;
      window: string;
      procedures: Array<{
        name: string;
        required: boolean;
        notes?: string;
      }>;
    }>;
    procedures: string[];
  };
}

export class AIService {
  private openai: OpenAI | null = null;
  private complexity: number = 0;
  private completeness: number = 0;
  private efficiency: number = 0;

  public setApiKey(key: string): void {
    // Removed setApiKey method as it's no longer needed
  }

  public getApiKey(): string | null {
    // Removed getApiKey method as it's no longer needed
    return null;
  }

  private ensureInitialized(): void {
    const settings = useSettingsStore.getState();
    if (!settings.hasValidApiKey()) {
      throw new Error('OpenAI API key not set or invalid');
    }
    
    if (!this.openai) {
      this.openai = new OpenAI({
        apiKey: settings.openAIApiKey,
        dangerouslyAllowBrowser: true // Note: In production, use a backend proxy
      });
    }
  }

  private chunkText(text: string): string[] {
    const chunks: string[] = [];
    const sentences = text.split(/[.!?]+\s/);
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > MAX_CHUNK_SIZE) {
        chunks.push(currentChunk);
        currentChunk = sentence;
      } else {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk);
    }
    
    return chunks;
  }

  private async analyzeChunk(chunk: string, studyDetails: any): Promise<any> {
    this.ensureInitialized();

    const response = await this.openai!.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are an expert in clinical trial protocol analysis. Analyze this section of the protocol for:
          - Overall complexity and completeness
          - Potential improvements and optimizations
          - Study schedule and visit structure
          Consider the context: ${JSON.stringify(studyDetails)}`
        },
        {
          role: 'user',
          content: chunk
        }
      ],
      functions: [
        {
          name: 'analyze_protocol_section',
          description: 'Analyzes a section of clinical trial protocol',
          parameters: {
            type: 'object',
            properties: {
              sectionMetrics: {
                type: 'object',
                properties: {
                  complexity: { type: 'number' },
                  completeness: { type: 'number' },
                  efficiency: { type: 'number' }
                }
              },
              sectionSuggestions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    message: { type: 'string' },
                    impact: { type: 'string' },
                    recommendation: { type: 'string' }
                  }
                }
              },
              scheduleElements: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    visitName: { type: 'string' },
                    window: { type: 'string' },
                    procedures: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          }
        }
      ],
      function_call: { name: 'analyze_protocol_section' }
    });

    const functionCall = response.choices[0].message.function_call;
    if (!functionCall?.arguments) {
      throw new Error('Invalid response from AI service');
    }

    return JSON.parse(functionCall.arguments);
  }

  public async analyzeProtocol(content: string, studyDetails: any = {}): Promise<AIAnalysisResult> {
    this.ensureInitialized();

    try {
      const chunks = this.chunkText(content);
      
      // Process chunks concurrently in batches
      const batchSize = 3;
      const results = [];
      
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const batchResults = await Promise.all(
          batch.map(chunk => this.analyzeChunk(chunk, studyDetails))
        );
        results.push(...batchResults);
      }

      const aggregatedResults: AIAnalysisResult = {
        metrics: {
          complexity: 0,
          completeness: 0,
          efficiency: 0
        },
        suggestions: {
          improvements: []
        },
        studySchedule: {
          visits: [],
          procedures: []
        },
        sectionMetrics: {}
      };

      // Track section-specific metrics
      const sectionMetrics = new Map<string, {
        complexity: number;
        completeness: number;
        efficiency: number;
      }>();

      results.forEach((result, index) => {
        // Update overall metrics
        Object.keys(result.sectionMetrics).forEach(key => {
          aggregatedResults.metrics[key] += result.sectionMetrics[key] / chunks.length;
        });

        // Track section-specific metrics
        const sectionName = `Section ${index + 1}`;
        sectionMetrics.set(sectionName, result.sectionMetrics);

        // Process suggestions with improved categorization
        result.sectionSuggestions.forEach(suggestion => {
          const improvement = {
            id: uuidv4(),
            type: suggestion.type as any,
            message: suggestion.message,
            impact: suggestion.impact as any,
            recommendation: suggestion.recommendation,
            autoFixAvailable: this.canAutoFix(suggestion),
            section: sectionName,
            category: this.categorizeSuggestion(suggestion)
          };
          
          // Deduplicate similar suggestions
          const isDuplicate = aggregatedResults.suggestions.improvements.some(
            existing => this.areSuggestionsSimilar(existing, improvement)
          );
          
          if (!isDuplicate) {
            aggregatedResults.suggestions.improvements.push(improvement);
          }
        });

        // Process schedule with improved validation
        if (result.scheduleElements) {
          this.processScheduleElements(result.scheduleElements, aggregatedResults);
        }
      });

      // Sort suggestions by impact and category
      aggregatedResults.suggestions.improvements.sort((a, b) => {
        const impactOrder = { high: 0, medium: 1, low: 2 };
        return impactOrder[a.impact] - impactOrder[b.impact];
      });

      return {
        ...aggregatedResults,
        sectionMetrics: Object.fromEntries(sectionMetrics)
      };
    } catch (error) {
      console.error('Error analyzing protocol:', error);
      throw error;
    }
  }

  private async analyzeProtocolContent(content: string, studyDetails: any): Promise<any> {
    this.ensureInitialized();
    
    // Step 1: Initial Analysis - Understanding the protocol structure and content
    const structureAnalysis = await this.openai!.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are an expert clinical research protocol analyst. Analyze the protocol structure and identify key sections, missing elements, and areas for improvement. Focus on scientific rigor, regulatory compliance, and operational feasibility."
        },
        {
          role: "user",
          content: `Analyze this protocol content and study details:\n\nProtocol:\n${content}\n\nStudy Details:\n${JSON.stringify(studyDetails, null, 2)}`
        }
      ],
      temperature: 0.3,
    });

    // Step 2: Detailed Review - Generate specific suggestions for improvement
    const detailedReview = await this.openai!.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a clinical protocol optimization expert. Generate specific, actionable suggestions for protocol improvement. Consider: statistical design, endpoint selection, inclusion/exclusion criteria, safety monitoring, and operational efficiency. Format suggestions as structured improvements with clear rationale and impact assessment."
        },
        {
          role: "user",
          content: `Based on this analysis, generate detailed improvement suggestions:\n\n${structureAnalysis.choices[0].message.content}`
        }
      ],
      temperature: 0.4,
    });

    // Step 3: Schedule Analysis - Study timeline and visit optimization
    const scheduleAnalysis = await this.openai!.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a clinical operations expert. Analyze the study schedule and procedures. Optimize for patient burden, operational efficiency, and data quality. Consider visit windows, procedure scheduling, and resource utilization."
        },
        {
          role: "user",
          content: `Analyze and optimize the study schedule based on:\n\nProtocol Content:\n${content}\n\nStudy Details:\n${JSON.stringify(studyDetails, null, 2)}`
        }
      ],
      temperature: 0.3,
    });

    // Process and structure the results
    return this.processAnalysisResults(
      structureAnalysis.choices[0].message.content,
      detailedReview.choices[0].message.content,
      scheduleAnalysis.choices[0].message.content
    );
  }

  private async generateFinalProtocol(content: string, selectedSuggestions: string[], studyDetails: any): Promise<any> {
    this.ensureInitialized();

    // Step 1: Generate Enhanced Protocol Structure
    const structureGeneration = await this.openai!.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a clinical protocol writing expert. Create a detailed, well-structured protocol incorporating selected improvements. Follow ICH GCP guidelines and industry best practices. Use clear, precise language and maintain scientific rigor."
        },
        {
          role: "user",
          content: `Generate an enhanced protocol structure incorporating these suggestions:\n\nOriginal Protocol:\n${content}\n\nSelected Improvements:\n${JSON.stringify(selectedSuggestions, null, 2)}\n\nStudy Details:\n${JSON.stringify(studyDetails, null, 2)}`
        }
      ],
      temperature: 0.2,
    });

    // Step 2: Generate Detailed Protocol Sections
    const detailedProtocol = await this.openai!.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a clinical protocol content expert. Expand the protocol structure into fully detailed sections. Include comprehensive information for each section, maintaining consistency and clarity. Format the content with proper headings, subheadings, and formatting."
        },
        {
          role: "user",
          content: `Expand this protocol structure into detailed sections:\n\n${structureGeneration.choices[0].message.content}`
        }
      ],
      temperature: 0.3,
    });

    // Step 3: Generate Optimized Study Schedule
    const scheduleGeneration = await this.openai!.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are a clinical operations scheduling expert. Create a detailed, optimized study schedule. Include visit windows, procedures, and assessments. Format the schedule in a clear, tabular format with proper annotations and notes."
        },
        {
          role: "user",
          content: `Generate an optimized study schedule based on this protocol:\n\n${detailedProtocol.choices[0].message.content}`
        }
      ],
      temperature: 0.2,
    });

    // Process and format the final documents
    return this.processFinalDocuments(
      detailedProtocol.choices[0].message.content,
      scheduleGeneration.choices[0].message.content
    );
  }

  private processAnalysisResults(structureAnalysis: string, detailedReview: string, scheduleAnalysis: string): AIAnalysisResult {
    // Process and structure the analysis results
    const suggestions = this.parseSuggestions(detailedReview);
    const schedule = this.parseSchedule(scheduleAnalysis);
    const metrics = this.calculateMetrics(structureAnalysis);

    return {
      metrics,
      suggestions: {
        improvements: suggestions.map(s => ({
          id: uuidv4(),
          ...s,
        }))
      },
      studySchedule: schedule,
      sectionMetrics: this.calculateSectionMetrics(structureAnalysis)
    };
  }

  private processFinalDocuments(protocolContent: string, scheduleContent: string): FinalDocuments {
    return {
      protocol: this.formatProtocolContent(protocolContent),
      schedule: this.parseSchedule(scheduleContent)
    };
  }

  private parseSuggestions(review: string): any[] {
    // Enhanced suggestion parsing logic
    try {
      // Implementation details...
      return [];
    } catch (error) {
      console.error('Error parsing suggestions:', error);
      return [];
    }
  }

  private parseSchedule(scheduleContent: string): any {
    // Enhanced schedule parsing logic
    try {
      // Implementation details...
      return {
        visits: [],
        procedures: []
      };
    } catch (error) {
      console.error('Error parsing schedule:', error);
      return { visits: [], procedures: [] };
    }
  }

  private calculateMetrics(analysis: string): any {
    // Enhanced metrics calculation logic
    return {
      complexity: 0,
      completeness: 0,
      efficiency: 0
    };
  }

  private calculateSectionMetrics(analysis: string): any {
    // Enhanced section metrics calculation logic
    return {};
  }

  private formatProtocolContent(content: string): string {
    // Enhanced protocol formatting logic
    return content;
  }

  private canAutoFix(suggestion: any): boolean {
    // Determine if suggestion can be automatically applied
    const autoFixableTypes = ['formatting', 'terminology', 'standardization'];
    return autoFixableTypes.includes(suggestion.type.toLowerCase());
  }

  private categorizeSuggestion(suggestion: any): string {
    // Categorize suggestions for better organization
    const keywords = {
      safety: ['safety', 'risk', 'adverse', 'monitoring'],
      efficiency: ['efficiency', 'streamline', 'optimize'],
      compliance: ['compliance', 'regulatory', 'guideline'],
      quality: ['quality', 'data', 'collection'],
      design: ['design', 'endpoint', 'criteria']
    };

    for (const [category, terms] of Object.entries(keywords)) {
      if (terms.some(term => 
        suggestion.message.toLowerCase().includes(term) ||
        suggestion.recommendation.toLowerCase().includes(term)
      )) {
        return category;
      }
    }

    return 'general';
  }

  private areSuggestionsSimilar(a: any, b: any): boolean {
    // Check if two suggestions are similar using basic text similarity
    const similarity = (s1: string, s2: string) => {
      const words1 = new Set(s1.toLowerCase().split(/\W+/));
      const words2 = new Set(s2.toLowerCase().split(/\W+/));
      const intersection = new Set([...words1].filter(x => words2.has(x)));
      const union = new Set([...words1, ...words2]);
      return intersection.size / union.size;
    };

    const messageSimilarity = similarity(a.message, b.message);
    const recommendationSimilarity = similarity(a.recommendation, b.recommendation);
    
    return messageSimilarity > 0.7 || recommendationSimilarity > 0.7;
  }

  private processScheduleElements(elements: any[], results: AIAnalysisResult): void {
    elements.forEach(element => {
      const existingVisit = results.studySchedule.visits.find(
        v => v.name === element.visitName
      );

      if (existingVisit) {
        // Check for procedure conflicts
        element.procedures.forEach(proc => {
          const existingProc = existingVisit.procedures.find(p => p.name === proc);
          if (!existingProc) {
            existingVisit.procedures.push({
              name: proc,
              required: true,
              notes: this.validateProcedure(proc, element.visitName)
            });
          }
        });
      } else {
        // Add new visit with validated procedures
        results.studySchedule.visits.push({
          name: element.visitName,
          window: this.validateVisitWindow(element.window),
          procedures: element.procedures.map(proc => ({
            name: proc,
            required: true,
            notes: this.validateProcedure(proc, element.visitName)
          }))
        });
      }
    });

    // Update procedures list with validation
    const allProcedures = new Set<string>();
    results.studySchedule.visits.forEach(visit => {
      visit.procedures.forEach(proc => {
        allProcedures.add(proc.name);
      });
    });
    results.studySchedule.procedures = Array.from(allProcedures);
  }

  private validateVisitWindow(window: string): string {
    // Validate and standardize visit window format
    const windowPattern = /^([+-]?\d+)([dDwWmM])?$/;
    if (!windowPattern.test(window)) {
      return window + ' (needs review)';
    }
    return window;
  }

  private validateProcedure(proc: string, visitName: string): string | undefined {
    // Validate procedure compatibility and requirements
    const criticalProcedures = ['informed consent', 'eligibility', 'randomization'];
    const safetyProcedures = ['vital signs', 'adverse events', 'concomitant medications'];
    
    if (criticalProcedures.includes(proc.toLowerCase())) {
      return 'Critical procedure - requires documentation';
    }
    
    if (safetyProcedures.includes(proc.toLowerCase())) {
      return 'Safety assessment - follow protocol guidelines';
    }
    
    return undefined;
  }

  public async generateFinalDocuments(
    content: string,
    selectedSuggestions: string[],
    includeSchedule: boolean,
    analysisResults: AIAnalysisResult
  ): Promise<FinalDocuments> {
    this.ensureInitialized();

    try {
      // First, create a context object with all the necessary information
      const context = {
        originalContent: content,
        selectedSuggestions: selectedSuggestions,
        analysisResults: analysisResults,
        includeSchedule: includeSchedule
      };

      // Split the request into smaller chunks if needed
      const chunks = this.chunkText(content);
      let finalProtocol = '';

      // Process each chunk and combine the results
      for (const chunk of chunks) {
        const response = await this.openai!.chat.completions.create({
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content: `You are an expert in clinical trial protocol optimization. Generate an improved protocol section that:
              - Incorporates the selected improvements
              - Maintains clear structure and formatting
              - Uses professional medical terminology
              - Follows regulatory guidelines
              - Ensures consistency with other sections`
            },
            {
              role: 'user',
              content: JSON.stringify({
                chunk,
                context: context
              })
            }
          ]
        });

        const improvedSection = response.choices[0].message.content;
        if (improvedSection) {
          finalProtocol += improvedSection + '\n\n';
        }
      }

      // Generate the final schedule if requested
      let finalSchedule = analysisResults.studySchedule;
      if (includeSchedule) {
        const scheduleResponse = await this.openai!.chat.completions.create({
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content: 'You are an expert in clinical trial visit scheduling. Optimize the study schedule based on the protocol content and selected improvements.'
            },
            {
              role: 'user',
              content: JSON.stringify({
                originalSchedule: analysisResults.studySchedule,
                selectedSuggestions: selectedSuggestions,
                protocolContent: finalProtocol
              })
            }
          ],
          functions: [
            {
              name: 'generate_optimized_schedule',
              description: 'Generates an optimized study schedule',
              parameters: {
                type: 'object',
                properties: {
                  visits: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        window: { type: 'string' },
                        procedures: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              name: { type: 'string' },
                              required: { type: 'boolean' },
                              notes: { type: 'string' }
                            },
                            required: ['name', 'required']
                          }
                        }
                      },
                      required: ['name', 'window', 'procedures']
                    }
                  },
                  procedures: {
                    type: 'array',
                    items: { type: 'string' }
                  }
                },
                required: ['visits', 'procedures']
              }
            }
          ],
          function_call: { name: 'generate_optimized_schedule' }
        });

        const functionCall = scheduleResponse.choices[0].message.function_call;
        if (functionCall?.arguments) {
          finalSchedule = JSON.parse(functionCall.arguments);
        }
      }

      return {
        protocol: finalProtocol.trim(),
        schedule: finalSchedule
      };
    } catch (error) {
      console.error('Error generating final documents:', error);
      throw new Error(`Error generating final documents: ${error.message}`);
    }
  }

  public async sendChatMessage(content: string, history: any[]): Promise<string> {
    this.ensureInitialized();

    try {
      const response = await this.openai!.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content: 'You are a helpful clinical research assistant, providing clear and accurate information about clinical trials, protocols, and EDC systems.'
          },
          ...history,
          { role: 'user', content }
        ]
      });

      return response.choices[0].message.content || 'I apologize, but I was unable to generate a response.';
    } catch (error) {
      console.error('Error sending chat message:', error);
      throw error;
    }
  }
}

export const aiService = new AIService();