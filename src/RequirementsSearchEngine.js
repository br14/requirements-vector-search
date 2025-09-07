const { LocalIndex } = require('vectra');
const OpenAI = require('openai');
const fs = require('fs').promises;
const path = require('path');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

class RequirementsSearchEngine {
  constructor(indexPath = './requirements-index', openaiApiKey) {
    this.indexPath = indexPath;
    this.index = new LocalIndex(indexPath);
    this.openai = new OpenAI({ apiKey: openaiApiKey });
    this.isInitialized = false;
    this.debugMode = false;
  }

  // Enable/disable debug mode
  setDebugMode(enabled = true) {
    this.debugMode = enabled;
  }

  async initialize() {
    if (!this.isInitialized) {
      try {
        await this.index.createIndex();
        this.isInitialized = true;
      } catch (error) {
        // Index might already exist, try to use it
        if (error.message.includes('already exists')) {
          this.isInitialized = true;
        } else {
          throw error;
        }
      }
    }
  }

  // Split text into chunks for better searchability
  splitIntoChunks(text, chunkSize = 500, overlap = 50) {
    const words = text.split(/\s+/);
    const chunks = [];
    
    for (let i = 0; i < words.length; i += chunkSize - overlap) {
      const chunk = words.slice(i, i + chunkSize).join(' ');
      if (chunk.trim().length > 0) {
        chunks.push({
          text: chunk.trim(),
          startIndex: i,
          wordCount: Math.min(chunkSize, words.length - i)
        });
      }
    }
    
    return chunks;
  }

  // Extract text from Excel files with proper sheet and row tracking
  async extractTextFromExcel(filePath) {
    const workbook = XLSX.readFile(filePath);
    const results = [];
    
    workbook.SheetNames.forEach(sheetName => {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet['!ref']) return; // Skip empty sheets
      
      const range = XLSX.utils.decode_range(worksheet['!ref']);
      
      for (let row = range.s.r; row <= range.e.r; row++) {
        const rowData = [];
        for (let col = range.s.c; col <= range.e.c; col++) {
          const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
          const cell = worksheet[cellAddress];
          if (cell && cell.v) {
            rowData.push(String(cell.v));
          }
        }
        
        if (rowData.length > 0) {
          const text = rowData.join(' | ');
          results.push({
            text,
            sheet: sheetName,
            row: row + 1,
            rowRange: `${row + 1}:${row + 1}`
          });
        }
      }
    });
    
    return results;
  }

  // Extract text from different file formats
  async extractTextFromFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    
    try {
      switch (ext) {
        case '.pdf':
          const pdfBuffer = await fs.readFile(filePath);
          const pdfData = await pdfParse(pdfBuffer);
          return [{ text: pdfData.text, fileName, type: 'pdf' }];
          
        case '.docx':
          const docxBuffer = await fs.readFile(filePath);
          const result = await mammoth.extractRawText({ buffer: docxBuffer });
          return [{ text: result.value, fileName, type: 'docx' }];
          
        case '.xlsx':
        case '.xls':
          const excelData = await this.extractTextFromExcel(filePath);
          return excelData.map(item => ({
            ...item,
            fileName,
            type: 'excel'
          }));
          
        case '.txt':
        case '.md':
          const textContent = await fs.readFile(filePath, 'utf-8');
          return [{ text: textContent, fileName, type: 'text' }];
          
        default:
          throw new Error(`Unsupported file format: ${ext}`);
      }
    } catch (error) {
      console.error(`Error processing file ${filePath}:`, error);
      throw error;
    }
  }

  // Generate embeddings using OpenAI
  async generateEmbedding(text) {
    try {
      // Clean and normalize text before embedding
      const cleanText = text.trim().replace(/\s+/g, ' ');
      
      if (this.debugMode) {
        console.log(`Generating embedding for text (${cleanText.length} chars): ${cleanText.substring(0, 100)}...`);
      }
      
      const response = await this.openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: cleanText,
        encoding_format: 'float'
      });
      
      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  // Index a single document
  async indexDocument(filePath) {
    await this.initialize();
    
    if (this.debugMode) {
      console.log(`\n=== Indexing Document: ${filePath} ===`);
    }
    
    const extractedData = await this.extractTextFromFile(filePath);
    let totalChunks = 0;
    
    for (const data of extractedData) {
      if (this.debugMode) {
        console.log(`Processing ${data.type} content (${data.text.length} chars)`);
        if (data.sheet) {
          console.log(`  Sheet: ${data.sheet}, Row: ${data.row}`);
        }
      }
      
      const chunks = this.splitIntoChunks(data.text);
      
      if (this.debugMode) {
        console.log(`Split into ${chunks.length} chunks`);
      }
      
      // Process chunks in batches to avoid rate limits
      const batchSize = 5;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (chunk, batchIndex) => {
          const embedding = await this.generateEmbedding(chunk.text);
          
          const chunkId = data.sheet 
            ? `${data.fileName}_${data.sheet}_row${data.row}_chunk${i + batchIndex}`
            : `${data.fileName}_chunk_${i + batchIndex}`;
            
          if (this.debugMode) {
            console.log(`  Indexing chunk ${chunkId} (${chunk.text.length} chars)`);
          }
            
          await this.index.insertItem({
            id: chunkId,
            vector: embedding,
            metadata: {
              fileName: data.fileName,
              filePath,
              chunkIndex: i + batchIndex,
              text: chunk.text,
              wordCount: chunk.wordCount,
              preview: chunk.text.substring(0, 150) + '...',
              type: data.type,
              sheet: data.sheet || null,
              row: data.row || null,
              rowRange: data.rowRange || null,
              // Add debugging info
              originalTextLength: data.text.length,
              chunkStartIndex: chunk.startIndex
            }
          });
        }));
        
        // Small delay to respect API rate limits
        if (i + batchSize < chunks.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      totalChunks += chunks.length;
    }
    
    if (this.debugMode) {
      console.log(`=== Completed indexing: ${totalChunks} chunks created ===\n`);
    }
    
    return { fileName: path.basename(filePath), chunksCreated: totalChunks };
  }

  // Enhanced search with debugging capabilities
  async search(query, topK = 5, options = {}) {
    await this.initialize();
    
    const { 
      debug = this.debugMode,
      includeTextMatches = false,
      minScore = 0,
      showEmbeddingStats = false
    } = options;
    
    if (debug) {
      console.log(`\n=== Search Debug: "${query}" ===`);
    }
    
    // Generate embedding for the search query
    const queryEmbedding = await this.generateEmbedding(query);
    
    if (debug && showEmbeddingStats) {
      console.log(`Query embedding dimensions: ${queryEmbedding.length}`);
      console.log(`Query embedding sample: [${queryEmbedding.slice(0, 5).join(', ')}...]`);
    }
    
    // Perform vector similarity search
    const results = await this.index.queryItems(queryEmbedding, Math.max(topK * 3, 50)); // Get more for analysis
    
    if (debug) {
      console.log(`Vector search returned ${results.length} raw results`);
    }
    
    // Enhanced result processing with text matching analysis
    const processedResults = results.map(result => {
      const metadata = result.item.metadata;
      const score = result.score;
      const relevancePercentage = Math.round(score * 100);
      
      // Analyze text matches
      let textMatches = [];
      let hasDirectMatch = false;
      
      if (includeTextMatches) {
        const queryWords = query.toLowerCase().split(/\s+/);
        const text = metadata.text.toLowerCase();
        
        queryWords.forEach(word => {
          if (word.length > 2 && text.includes(word)) {
            textMatches.push(word);
            hasDirectMatch = true;
          }
        });
      }
      
      const processedResult = {
        score,
        fileName: metadata.fileName,
        text: metadata.text,
        preview: metadata.preview,
        chunkIndex: metadata.chunkIndex,
        relevancePercentage,
        type: metadata.type,
        sheet: metadata.sheet,
        row: metadata.row,
        rowRange: metadata.rowRange
      };
      
      if (includeTextMatches) {
        processedResult.textMatches = textMatches;
        processedResult.hasDirectMatch = hasDirectMatch;
        processedResult.textMatchScore = textMatches.length / query.split(/\s+/).length;
      }
      
      if (debug) {
        console.log(`Result ${metadata.fileName} (chunk ${metadata.chunkIndex}): ${relevancePercentage}% relevance`);
        if (includeTextMatches) {
          console.log(`  Direct matches: ${hasDirectMatch ? textMatches.join(', ') : 'none'}`);
          console.log(`  Text: "${metadata.text.substring(0, 100)}..."`);
        }
      }
      
      return processedResult;
    });
    
    // Filter by minimum score if specified
    let filteredResults = processedResults;
    if (minScore > 0) {
      filteredResults = processedResults.filter(r => r.score >= minScore);
      if (debug) {
        console.log(`Filtered to ${filteredResults.length} results with score >= ${minScore}`);
      }
    }
    
    // Sort results - prioritize direct text matches if using text matching
    if (includeTextMatches) {
      filteredResults.sort((a, b) => {
        // First by direct text match
        if (a.hasDirectMatch && !b.hasDirectMatch) return -1;
        if (!a.hasDirectMatch && b.hasDirectMatch) return 1;
        
        // Then by text match score
        if (a.textMatchScore !== b.textMatchScore) {
          return b.textMatchScore - a.textMatchScore;
        }
        
        // Finally by vector similarity
        return b.score - a.score;
      });
    }
    
    const finalResults = filteredResults.slice(0, topK);
    
    if (debug) {
      console.log(`=== Final Results (${finalResults.length}/${processedResults.length}) ===`);
      finalResults.forEach((result, i) => {
        console.log(`${i + 1}. ${result.fileName} - ${result.relevancePercentage}%`);
        if (includeTextMatches && result.hasDirectMatch) {
          console.log(`   Text matches: ${result.textMatches.join(', ')}`);
        }
      });
      console.log('=== End Search Debug ===\n');
    }
    
    return finalResults;
  }

  // New method: Analyze search results for debugging
  async analyzeSearch(query, options = {}) {
    const results = await this.search(query, 20, {
      ...options,
      debug: true,
      includeTextMatches: true,
      showEmbeddingStats: true
    });
    
    // Group results by file for analysis
    const fileGroups = {};
    results.forEach(result => {
      if (!fileGroups[result.fileName]) {
        fileGroups[result.fileName] = [];
      }
      fileGroups[result.fileName].push(result);
    });
    
    console.log('\n=== SEARCH ANALYSIS REPORT ===');
    console.log(`Query: "${query}"`);
    console.log(`Total results: ${results.length}`);
    console.log(`Files represented: ${Object.keys(fileGroups).length}`);
    
    // Analyze text matches vs vector scores
    const withTextMatches = results.filter(r => r.hasDirectMatch);
    const withoutTextMatches = results.filter(r => !r.hasDirectMatch);
    
    console.log(`\nResults with direct text matches: ${withTextMatches.length}`);
    console.log(`Results without direct text matches: ${withoutTextMatches.length}`);
    
    if (withTextMatches.length > 0) {
      const avgScoreWithMatches = withTextMatches.reduce((sum, r) => sum + r.score, 0) / withTextMatches.length;
      console.log(`Average vector score with text matches: ${(avgScoreWithMatches * 100).toFixed(1)}%`);
    }
    
    if (withoutTextMatches.length > 0) {
      const avgScoreWithoutMatches = withoutTextMatches.reduce((sum, r) => sum + r.score, 0) / withoutTextMatches.length;
      console.log(`Average vector score without text matches: ${(avgScoreWithoutMatches * 100).toFixed(1)}%`);
    }
    
    console.log('\n=== FILE ANALYSIS ===');
    Object.entries(fileGroups).forEach(([fileName, fileResults]) => {
      const hasMatches = fileResults.some(r => r.hasDirectMatch);
      const maxScore = Math.max(...fileResults.map(r => r.score));
      console.log(`${fileName}: ${fileResults.length} chunks, max score: ${(maxScore * 100).toFixed(1)}%, has matches: ${hasMatches}`);
    });
    
    console.log('=== END ANALYSIS ===\n');
    
    return {
      query,
      totalResults: results.length,
      filesRepresented: Object.keys(fileGroups).length,
      withTextMatches: withTextMatches.length,
      withoutTextMatches: withoutTextMatches.length,
      fileGroups,
      results
    };
  }

  // New method: Find all chunks containing specific text
  async findExactText(searchText, caseSensitive = false) {
    await this.initialize();
    
    const allItems = await this.index.listItems();
    const matches = [];
    
    allItems.forEach(item => {
      const text = caseSensitive ? item.metadata.text : item.metadata.text.toLowerCase();
      const search = caseSensitive ? searchText : searchText.toLowerCase();
      
      if (text.includes(search)) {
        matches.push({
          fileName: item.metadata.fileName,
          chunkIndex: item.metadata.chunkIndex,
          text: item.metadata.text,
          preview: item.metadata.preview,
          type: item.metadata.type,
          sheet: item.metadata.sheet,
          row: item.metadata.row,
          id: item.id
        });
      }
    });
    
    console.log(`\n=== EXACT TEXT SEARCH: "${searchText}" ===`);
    console.log(`Found ${matches.length} chunks containing the text`);
    
    matches.forEach((match, i) => {
      console.log(`${i + 1}. ${match.fileName} (chunk ${match.chunkIndex})`);
      if (match.sheet) {
        console.log(`   Sheet: ${match.sheet}, Row: ${match.row}`);
      }
      console.log(`   Text: "${match.text.substring(0, 200)}..."`);
    });
    
    console.log('=== END EXACT TEXT SEARCH ===\n');
    
    return matches;
  }

  // Get statistics about the indexed documents
  async getStats() {
    await this.initialize();
    
    try {
      const items = await this.index.listItems();
      const fileNames = [...new Set(items.map(item => item.metadata.fileName))];
      
      return {
        totalChunks: items.length,
        totalDocuments: fileNames.length,
        documents: fileNames,
        indexPath: this.indexPath
      };
    } catch (error) {
      // If index doesn't exist or is empty
      return {
        totalChunks: 0,
        totalDocuments: 0,
        documents: [],
        indexPath: this.indexPath
      };
    }
  }

  // Clear the entire index
  async clearIndex() {
    try {
      await this.index.deleteIndex();
      this.isInitialized = false;
    } catch (error) {
      // Index might not exist
      if (!error.message.includes('does not exist')) {
        throw error;
      }
    }
  }

  // Backup index
  async backupIndex(backupPath) {
    const fs = require('fs-extra');
    const timestamp = Date.now();
    
    try {
      await fs.copy(this.indexPath, backupPath);
      return {
        originalPath: this.indexPath,
        backupPath,
        timestamp
      };
    } catch (error) {
      throw new Error(`Backup failed: ${error.message}`);
    }
  }

  // Restore index from backup
  async restoreIndex(backupPath) {
    const fs = require('fs-extra');
    
    try {
      // Clear current index
      await this.clearIndex();
      
      // Copy backup to index location
      await fs.copy(backupPath, this.indexPath);
      
      // Reinitialize
      this.isInitialized = false;
      await this.initialize();
      
      return await this.getStats();
    } catch (error) {
      throw new Error(`Restore failed: ${error.message}`);
    }
  }
}

module.exports = RequirementsSearchEngine;