#define _CRT_SECURE_NO_WARNINGS
#include <stdio.h>
#include <stdlib.h>

struct node {
	node * prev, * next;
	int val;
	node(int v, node* p, node* n) {
		prev = p; next = n;
		val = v;
	}
};


void addNode(node* p, node* newnode, int d){
	if (p->val <= newnode->val ) {
		if (p->prev) {
			addNode(p->prev, newnode,NULL);
		}
		else {

		}
	}
	else {

	}
}

int main() {
	int N, K;
	int v[5000];
	int len;
	scanf("%d %d", &N,&K);
	len = 0;
	while (len < N) {
		scanf("%d", v+len%K);
		len++;
		if (len < K) continue;

		// sorting
		
		// 
		
		
	}

	system("pause");

	return 0;
}