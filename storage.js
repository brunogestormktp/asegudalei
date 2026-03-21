// LocalStorage management
const StorageManager = {
    STORAGE_KEY: 'habit-tracker-data',

    // Get all data
    getData() {
        const data = localStorage.getItem(this.STORAGE_KEY);
        return data ? JSON.parse(data) : {};
    },

    // Save all data
    saveData(data) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    },

    // Get data for a specific date
    getDateData(dateStr) {
        const allData = this.getData();
        return allData[dateStr] || {};
    },

    // Save status for a specific item on a specific date
    saveItemStatus(dateStr, category, itemId, status, note = '') {
        const allData = this.getData();
        
        if (!allData[dateStr]) {
            allData[dateStr] = {};
        }
        
        if (!allData[dateStr][category]) {
            allData[dateStr][category] = {};
        }
        
        allData[dateStr][category][itemId] = {
            status: status,
            note: note,
            updatedAt: new Date().toISOString()
        };
        
        this.saveData(allData);
    },

    // Get status for a specific item on a specific date
    getItemStatus(dateStr, category, itemId) {
        const dateData = this.getDateData(dateStr);
        const itemData = dateData[category]?.[itemId];
        
        if (!itemData) {
            return { status: 'none', note: '' };
        }
        
        // Handle old format (just status string)
        if (typeof itemData === 'string') {
            return { status: itemData, note: '' };
        }
        
        return {
            status: itemData.status || 'none',
            note: itemData.note || ''
        };
    },

    // Get all dates with data
    getAllDates() {
        const allData = this.getData();
        return Object.keys(allData).sort().reverse();
    },

    // Get data for a date range
    getDateRangeData(startDate, endDate) {
        const allData = this.getData();
        const result = {};
        
        for (const dateStr in allData) {
            const date = new Date(dateStr);
            if (date >= startDate && date <= endDate) {
                result[dateStr] = allData[dateStr];
            }
        }
        
        return result;
    },

    // Calculate statistics for a period
    calculateStats(startDate, endDate) {
        const rangeData = this.getDateRangeData(startDate, endDate);
        const stats = {
            totalDays: Object.keys(rangeData).length,
            byCategory: {},
            overall: {
                total: 0,
                completed: 0,
                inProgress: 0,
                notDone: 0,
                skipped: 0
            }
        };

        // Initialize category stats
        ['clientes', 'categorias', 'atividades'].forEach(cat => {
            stats.byCategory[cat] = {
                total: 0,
                completed: 0,
                inProgress: 0,
                notDone: 0,
                skipped: 0,
                completionRate: 0
            };
        });

        // Process each date
        for (const dateStr in rangeData) {
            const dayData = rangeData[dateStr];
            
            for (const category in dayData) {
                const categoryData = dayData[category];
                
                for (const itemId in categoryData) {
                    const itemData = categoryData[itemId];
                    // Handle both old format (string) and new format (object)
                    const status = typeof itemData === 'string' ? itemData : itemData.status;
                    const statusConfig = STATUS_CONFIG[status];
                    
                    stats.byCategory[category].total++;
                    stats.overall.total++;
                    
                    if (status === 'concluido' || status === 'concluido-ongoing') {
                        stats.byCategory[category].completed++;
                        stats.overall.completed++;
                    } else if (status === 'em-andamento' || status === 'parcialmente') {
                        stats.byCategory[category].inProgress++;
                        stats.overall.inProgress++;
                    } else if (status === 'nao-feito' || status === 'bloqueado') {
                        stats.byCategory[category].notDone++;
                        stats.overall.notDone++;
                    } else if (status === 'pular') {
                        stats.byCategory[category].skipped++;
                        stats.overall.skipped++;
                    }
                }
            }
        }

        // Calculate completion rates
        for (const cat in stats.byCategory) {
            const catStats = stats.byCategory[cat];
            const totalNotSkipped = catStats.total - catStats.skipped;
            if (totalNotSkipped > 0) {
                catStats.completionRate = ((catStats.completed / totalNotSkipped) * 100).toFixed(1);
            }
        }

        const overallNotSkipped = stats.overall.total - stats.overall.skipped;
        if (overallNotSkipped > 0) {
            stats.overall.completionRate = ((stats.overall.completed / overallNotSkipped) * 100).toFixed(1);
        }

        return stats;
    },

    // Export data as JSON
    exportData() {
        const data = this.getData();
        const dataStr = JSON.stringify(data, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `habit-tracker-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    },

    // Import data from JSON
    importData(jsonStr) {
        try {
            const data = JSON.parse(jsonStr);
            this.saveData(data);
            return true;
        } catch (e) {
            console.error('Error importing data:', e);
            return false;
        }
    },

    // Clear all data
    clearAllData() {
        if (confirm('Tem certeza que deseja apagar todos os dados? Esta ação não pode ser desfeita.')) {
            localStorage.removeItem(this.STORAGE_KEY);
            return true;
        }
        return false;
    }
};
